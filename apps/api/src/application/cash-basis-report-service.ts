import { ValidationError } from '../domain/errors.js';
import { AccountingPermissions, isValidIsoDate } from '../modules/accounting/index.js';
import { buildProfitAndLoss } from '../modules/reports/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { queryCashBasisAccounts } from './cash-basis-query.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Cash-basis profit and loss (FP-22). Same statement layout as the accrual profit and loss, with
 * revenue and expense recognised when settled (method and open policy questions in
 * docs/design/cash-basis-reports.md). Read-only, needs `accounting.reports.view`.
 */
export class CashBasisReportService {
  constructor(private readonly deps: AppDependencies) {}

  profitAndLoss(principal: Principal, input: { from: string; to: string; includeZero: boolean }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.ReportsView, readOnlySnapshot: true },
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
        const accounts = await queryCashBasisAccounts(tx, {
          organizationId: ctx.organizationId,
          from: input.from,
          to: input.to,
        });
        const column = {
          key: 'current' as const,
          label: `${input.from} – ${input.to}`,
          from: input.from,
          to: input.to,
        };
        const result = buildProfitAndLoss({
          columns: [{ ...column, accounts }],
          baseCurrency: settings.baseCurrency,
          includeZero: input.includeZero,
          currencyView: 'base',
          tagged: false,
        });
        return {
          report: 'profit_and_loss_cash_basis' as const,
          basis: 'cash' as const,
          baseCurrency: settings.baseCurrency,
          columns: [{ key: column.key, label: column.label, from: column.from, to: column.to }],
          includeZero: input.includeZero,
          // Said in the data, not only in the docs, so every client can show it.
          method:
            'Sales and purchase documents are recognised in proportion to what was settled, on the settlement dates. Other journals are recognised as booked.',
          ...result,
          generatedAt: this.deps.clock.now().toISOString(),
        };
      },
    );
  }
}
