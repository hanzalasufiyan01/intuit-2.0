import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getAccount, isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { BankingPermissions } from '../modules/banking/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod, journalLine } from './sales-documents.js';

/**
 * Petty cash funds and counts (migration 0093; owner decision of 2026-10-19, ADR 0015). A fund is
 * a named float with a custodian on a cash account of the ledger. A count compares the cash
 * counted with the ledger balance of that account; a difference is posted through the accounting
 * event 'petty_cash.count_posted' to the cash over/short account the organization chose. Spending
 * from the fund and topping it up are ordinary ledger entries made elsewhere.
 */

export const PETTY_CASH_COUNT_EVENT = 'petty_cash.count_posted';

const AMOUNT = /^(0|[1-9]\d{0,21})(\.\d{1,4})?$/;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The record changed; reload it and try again.');

interface FundRow {
  id: string;
  name: string;
  accountId: string;
  custodianName: string;
  floatAmount: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  [key: string]: unknown;
}
interface CountRow {
  id: string;
  number: string;
  fundId: string;
  countDate: string;
  countedAmount: string;
  bookBalance: string;
  difference: string;
  journalId: string | null;
  memo: string;
  [key: string]: unknown;
}

const FUND_COLUMNS = sql`id, name, account_id AS "accountId", custodian_name AS "custodianName",
  float_amount::text AS "floatAmount", status, version`;
const COUNT_COLUMNS = sql`id, number, fund_id AS "fundId", count_date::text AS "countDate",
  counted_amount::text AS "countedAmount", book_balance::text AS "bookBalance",
  difference::text AS difference, journal_id AS "journalId", memo`;

const fundView = (f: FundRow) => ({ ...f, floatAmount: new Decimal(f.floatAmount).toFixed() });
const countView = (c: CountRow) => ({
  ...c,
  countedAmount: new Decimal(c.countedAmount).toFixed(),
  bookBalance: new Decimal(c.bookBalance).toFixed(),
  difference: new Decimal(c.difference).toFixed(),
});

export class PettyCashService {
  constructor(
    private readonly deps: AppDependencies,
    journals: JournalService,
  ) {
    // The journal is complete when the event is received (Decision 13); Petty cash posts under its
    // own permissions.
    journals.registerEventHandler(PETTY_CASH_COUNT_EVENT, (e) => e.payload.journal as never, {
      domainApproval: true,
    });
    this.journals = journals;
  }

  private readonly journals: JournalService;

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  private need(ctx: AuthorizationContext, key: string) {
    if (!hasPermission(ctx, key)) throw new PermissionDeniedError();
  }

  /** An active, base-currency CASH asset account that no other active fund uses. */
  private async checkFundAccount(
    tx: Transaction,
    organizationId: string,
    accountId: string,
  ): Promise<ValidationIssue | null> {
    const settings = await requireAccountingSettings(tx, organizationId);
    const account = await getAccount(tx, organizationId, accountId);
    const path = 'accountId';
    if (!account) return { path, message: 'Choose an account of this organization.' };
    if (account.accountType !== 'ASSET' || account.subtype !== 'CASH') {
      return { path, message: 'Choose a cash account (an asset account of the cash kind).' };
    }
    if (account.status !== 'ACTIVE' || !account.isLeaf || account.isControlAccount) {
      return { path, message: 'Choose an active posting cash account.' };
    }
    if (account.currencyCode !== settings.baseCurrency) {
      return { path, message: 'The cash account must be in the base currency.' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(principal: Principal) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.TransactionsView);
      const r = await tx.execute<{ over_short_account_id: string | null; version: number }>(sql`
        SELECT over_short_account_id, version FROM petty_cash_settings WHERE organization_id = ${ctx.organizationId}`);
      return {
        overShortAccountId: r.rows[0]?.over_short_account_id ?? null,
        version: r.rows[0]?.version ?? 0,
      };
    });
  }

  /** `version` 0 creates the row. The over/short account must be an active expense account. */
  setSettings(
    principal: Principal,
    input: { overShortAccountId: string | null; version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.AccountsManage);
      await requireAccountingSettings(tx, ctx.organizationId);
      if (input.overShortAccountId) {
        const a = await getAccount(tx, ctx.organizationId, input.overShortAccountId);
        if (!a || a.accountType !== 'EXPENSE' || a.status !== 'ACTIVE' || !a.isLeaf) {
          throw new ValidationError([
            { path: 'overShortAccountId', message: 'Choose an active expense account.' },
          ]);
        }
      }
      const at = this.now.toISOString();
      const existing = await tx.execute<{ version: number }>(sql`
        SELECT version FROM petty_cash_settings WHERE organization_id = ${ctx.organizationId} FOR UPDATE`);
      if (!existing.rows[0]) {
        if (input.version !== 0) throw versionConflict();
        await tx.execute(sql`INSERT INTO petty_cash_settings
          (organization_id, over_short_account_id, updated_by_user_id, updated_at)
          VALUES (${ctx.organizationId}, ${input.overShortAccountId}, ${ctx.userId}, ${at}::timestamptz)`);
      } else {
        if (existing.rows[0].version !== input.version) throw versionConflict();
        await tx.execute(sql`UPDATE petty_cash_settings SET over_short_account_id = ${input.overShortAccountId},
          version = version + 1, updated_by_user_id = ${ctx.userId}, updated_at = ${at}::timestamptz
          WHERE organization_id = ${ctx.organizationId}`);
      }
      await this.audit(
        tx,
        ctx,
        'petty_cash.settings_updated',
        'petty_cash_settings',
        ctx.organizationId,
        origin,
        {
          overShortAccountId: input.overShortAccountId,
        },
      );
      return { overShortAccountId: input.overShortAccountId, version: input.version + 1 };
    });
  }

  // ---------------------------------------------------------------------------
  // Funds
  // ---------------------------------------------------------------------------

  listFunds(principal: Principal) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.TransactionsView);
      const r = await tx.execute<FundRow>(sql`
        SELECT ${FUND_COLUMNS} FROM petty_cash_funds WHERE organization_id = ${ctx.organizationId}
         ORDER BY status, lower(name), id`);
      const out = [];
      for (const f of r.rows) {
        out.push({
          ...fundView(f),
          bookBalance: await this.bookBalance(
            tx,
            ctx.organizationId,
            f.accountId,
            this.now.toISOString().slice(0, 10),
          ),
        });
      }
      return out;
    });
  }

  /** Ledger balance of the cash account up to a date (posted and reversed journals), in base. */
  private async bookBalance(
    tx: Transaction,
    organizationId: string,
    accountId: string,
    to: string,
  ) {
    const r = await tx.execute<{ b: string }>(sql`
      SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::text AS b
        FROM accounting_journal_lines l
        JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId} AND l.account_id = ${accountId}
         AND j.status IN ('POSTED', 'REVERSED') AND j.entry_date <= ${to}::date`);
    return new Decimal(r.rows[0]?.b ?? '0').toFixed();
  }

  createFund(
    principal: Principal,
    input: { name: string; accountId: string; custodianName: string; floatAmount: string },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.AccountsManage);
      const issues: ValidationIssue[] = [];
      if (!AMOUNT.test(input.floatAmount))
        issues.push({ path: 'floatAmount', message: 'Enter an amount of zero or more.' });
      const problem = await this.checkFundAccount(tx, ctx.organizationId, input.accountId);
      if (problem) issues.push(problem);
      if (issues.length) throw new ValidationError(issues);
      const at = this.now.toISOString();
      let row: FundRow | undefined;
      try {
        const r = await tx.execute<FundRow>(sql`
          INSERT INTO petty_cash_funds (organization_id, name, account_id, custodian_name, float_amount,
                                        created_by_user_id, created_at, updated_by_user_id, updated_at)
          VALUES (${ctx.organizationId}, ${input.name.trim()}, ${input.accountId}, ${input.custodianName.trim()},
                  ${new Decimal(input.floatAmount).toFixed(4)}, ${ctx.userId}, ${at}::timestamptz, ${ctx.userId}, ${at}::timestamptz)
          RETURNING ${FUND_COLUMNS}`);
        row = r.rows[0];
      } catch {
        throw new ConflictError(
          'CONFLICT',
          'A fund with this name or cash account already exists.',
        );
      }
      await this.audit(tx, ctx, 'petty_cash.fund_created', 'petty_cash_fund', row!.id, origin, {
        accountId: input.accountId,
      });
      return fundView(row!);
    });
  }

  updateFund(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      custodianName?: string | undefined;
      floatAmount?: string | undefined;
      status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.AccountsManage);
      const cur = await tx.execute<FundRow>(sql`
        SELECT ${FUND_COLUMNS} FROM petty_cash_funds WHERE organization_id = ${ctx.organizationId} AND id = ${id} FOR UPDATE`);
      const fund = cur.rows[0];
      if (!fund) throw new NotFoundError('Fund not found.');
      if (fund.version !== input.version) throw versionConflict();
      if (input.floatAmount !== undefined && !AMOUNT.test(input.floatAmount)) {
        throw new ValidationError([
          { path: 'floatAmount', message: 'Enter an amount of zero or more.' },
        ]);
      }
      let updated: FundRow | undefined;
      try {
        const r = await tx.execute<FundRow>(sql`
          UPDATE petty_cash_funds SET
            name = COALESCE(${input.name?.trim() ?? null}, name),
            custodian_name = COALESCE(${input.custodianName?.trim() ?? null}, custodian_name),
            float_amount = COALESCE(${input.floatAmount ? new Decimal(input.floatAmount).toFixed(4) : null}::numeric, float_amount),
            status = COALESCE(${input.status ?? null}, status),
            version = version + 1, updated_by_user_id = ${ctx.userId}, updated_at = ${this.now.toISOString()}::timestamptz
           WHERE organization_id = ${ctx.organizationId} AND id = ${id} AND version = ${input.version}
       RETURNING ${FUND_COLUMNS}`);
        updated = r.rows[0];
      } catch {
        throw new ConflictError(
          'CONFLICT',
          'A fund with this name or cash account already exists.',
        );
      }
      if (!updated) throw versionConflict();
      await this.audit(tx, ctx, 'petty_cash.fund_updated', 'petty_cash_fund', id, origin, {
        changed: Object.keys(input).filter((k) => k !== 'version'),
      });
      return fundView(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Counts
  // ---------------------------------------------------------------------------

  listCounts(principal: Principal, fundId: string | undefined, limit: number) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.TransactionsView);
      const r = await tx.execute<CountRow>(sql`
        SELECT ${COUNT_COLUMNS} FROM petty_cash_counts
         WHERE organization_id = ${ctx.organizationId}
           AND (${fundId ?? null}::uuid IS NULL OR fund_id = ${fundId ?? null}::uuid)
         ORDER BY count_date DESC, number DESC LIMIT ${limit}`);
      return r.rows.map(countView);
    });
  }

  /**
   * Records a count. A difference is posted to the over/short account (which must be set); an
   * exact count posts nothing. The count is final and cannot be edited or deleted.
   */
  recordCount(
    principal: Principal,
    fundId: string,
    input: { countDate: string; countedAmount: string; memo?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.need(ctx, BankingPermissions.Reconcile);
      const issues: ValidationIssue[] = [];
      if (
        !isValidIsoDate(input.countDate) ||
        input.countDate > this.now.toISOString().slice(0, 10)
      ) {
        issues.push({
          path: 'countDate',
          message: 'Enter a valid date that is not in the future.',
        });
      }
      if (!AMOUNT.test(input.countedAmount)) {
        issues.push({ path: 'countedAmount', message: 'Enter the cash counted (zero or more).' });
      }
      if (issues.length) throw new ValidationError(issues);
      const cur = await tx.execute<FundRow>(sql`
        SELECT ${FUND_COLUMNS} FROM petty_cash_funds WHERE organization_id = ${ctx.organizationId} AND id = ${fundId} FOR UPDATE`);
      const fund = cur.rows[0];
      if (!fund) throw new NotFoundError('Fund not found.');
      if (fund.status !== 'ACTIVE')
        throw new ConflictError('INVALID_STATE_TRANSITION', 'The fund is archived.');
      const counted = new Decimal(input.countedAmount);
      const book = new Decimal(
        await this.bookBalance(tx, ctx.organizationId, fund.accountId, input.countDate),
      );
      const difference = counted.minus(book);
      let journalId: string | null = null;
      const countId = randomUUID();
      // Number first, so the journal can carry it.
      await tx.execute(
        sql`INSERT INTO petty_cash_count_sequences (organization_id) VALUES (${ctx.organizationId}) ON CONFLICT DO NOTHING`,
      );
      const seq = await tx.execute<{ prefix: string; min_digits: number; next_number: string }>(sql`
        UPDATE petty_cash_count_sequences SET next_number = next_number + 1
         WHERE organization_id = ${ctx.organizationId} RETURNING prefix, min_digits, next_number::text AS next_number`);
      const number = `${seq.rows[0]!.prefix}${(BigInt(seq.rows[0]!.next_number) - 1n).toString().padStart(seq.rows[0]!.min_digits, '0')}`;
      if (!difference.isZero()) {
        const s = await tx.execute<{ over_short_account_id: string | null }>(sql`
          SELECT over_short_account_id FROM petty_cash_settings WHERE organization_id = ${ctx.organizationId}`);
        const overShort = s.rows[0]?.over_short_account_id ?? null;
        if (!overShort) {
          throw new ValidationError([
            {
              path: 'settings',
              message: 'Choose the cash over/short account in the petty cash settings first.',
            },
          ]);
        }
        await assertOpenPeriod(tx, ctx.organizationId, input.countDate);
        const amount = difference.abs().toFixed(4);
        const over = difference.gt(0);
        const text = `Petty cash count ${number} — ${fund.name}`.slice(0, 500);
        const sides = [
          { accountId: fund.accountId, side: over ? ('debit' as const) : ('credit' as const) },
          { accountId: overShort, side: over ? ('credit' as const) : ('debit' as const) },
        ];
        const lines = sides.map((x) => ({
          role: 'payable' as const,
          accountId: x.accountId,
          side: x.side,
          amount: new Decimal(amount),
          description: text,
          dimensionValueIds: [] as string[],
          baseAmount: new Decimal(0),
        }));
        const event = await this.journals.receiveEventInTransaction(tx, {
          organizationId: ctx.organizationId,
          sourceModule: 'petty_cash',
          eventType: PETTY_CASH_COUNT_EVENT,
          eventKey: `petty_cash_count:${countId}:posted`,
          payload: {
            countId,
            number,
            journal: {
              entryDate: input.countDate,
              description: text,
              reference: number,
              currency: (await requireAccountingSettings(tx, ctx.organizationId)).baseCurrency,
              exchangeRate: null,
              sourceRef: { module: 'petty_cash', type: 'count', id: countId },
              lines: lines.map((l) => journalLine(l, number, new Map())),
            },
          },
          occurredAt: this.now,
          origin,
        });
        if (!event.journalId)
          throw new AppError('CONFLICT', 409, 'The count was not posted; try again.');
        journalId = event.journalId;
      }
      await tx.execute(sql`
        INSERT INTO petty_cash_counts (id, organization_id, number, fund_id, count_date, counted_amount,
                                       book_balance, difference, journal_id, memo, created_by_user_id, created_at)
        VALUES (${countId}, ${ctx.organizationId}, ${number}, ${fundId}, ${input.countDate}::date,
                ${counted.toFixed(4)}, ${book.toFixed(4)}, ${difference.toFixed(4)}, ${journalId},
                ${(input.memo ?? '').trim().slice(0, 500)}, ${ctx.userId}, ${this.now.toISOString()}::timestamptz)`);
      await this.audit(tx, ctx, 'petty_cash.counted', 'petty_cash_count', countId, origin, {
        number,
        fundId,
        difference: difference.toFixed(4),
      });
      const created = await tx.execute<CountRow>(sql`
        SELECT ${COUNT_COLUMNS} FROM petty_cash_counts WHERE organization_id = ${ctx.organizationId} AND id = ${countId}`);
      return countView(created.rows[0]!);
    });
  }
}
