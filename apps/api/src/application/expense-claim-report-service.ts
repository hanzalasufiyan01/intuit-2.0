import { ValidationError } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { claimantTotals, ExpenseClaimPermissions } from '../modules/expense-claims/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Expense claims by claimant (FP-22): for claim dates in a range, per employee, the claims waiting
 * for approval, approved and posted (reimbursable) with their totals. Claimants are the employee
 * parties of the claims (Contacts), not payroll employees. Read-only; needs
 * `expense_claims.view`.
 */
export class ExpenseClaimReportService {
  constructor(private readonly deps: AppDependencies) {}

  byClaimant(principal: Principal, input: { from: string; to: string }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) {
          throw new ValidationError([
            {
              path: 'to',
              message: 'Enter a valid range: the end date must not precede the start.',
            },
          ]);
        }
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const rows = await claimantTotals(tx, ctx.organizationId, input);
        const byParty = new Map<
          string,
          {
            partyId: string;
            displayName: string;
            pending: string;
            approved: string;
            posted: string;
            claims: number;
            total: string;
          }
        >();
        for (const r of rows) {
          const entry = byParty.get(r.partyId) ?? {
            partyId: r.partyId,
            displayName: r.displayName,
            pending: '0',
            approved: '0',
            posted: '0',
            claims: 0,
            total: '0',
          };
          const key =
            r.status === 'PENDING_APPROVAL'
              ? 'pending'
              : r.status === 'APPROVED'
                ? 'approved'
                : 'posted';
          entry[key] = decimal(entry[key]).plus(r.total).toFixed();
          entry.claims += r.claims;
          entry.total = decimal(entry.total).plus(r.total).toFixed();
          byParty.set(r.partyId, entry);
        }
        const claimants = [...byParty.values()].sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        );
        return {
          baseCurrency: settings.baseCurrency,
          from: input.from,
          to: input.to,
          claimants,
          totals: {
            claims: claimants.reduce((n, c) => n + c.claims, 0),
            total: claimants.reduce((sum, c) => sum.plus(c.total), decimal(0)).toFixed(),
          },
        };
      },
    );
  }
}
