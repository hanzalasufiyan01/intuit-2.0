import { z } from 'zod';
import { ledgerQuery } from '../../api/v1/accounting.routes.js';
import {
  balanceSheetQuery,
  profitAndLossQuery,
  trialBalanceQuery,
} from '../../api/v1/reports.routes.js';
import { NotFoundError, PermissionDeniedError } from '../../domain/errors.js';
import { decimal } from '../../domain/money.js';
import type { Transaction } from '../../database/client.js';
import {
  AccountingPermissions,
  findOpenOpeningBatch,
  fixedAmount,
  getOpeningBatch,
  listAccounts,
  listOpeningBatches,
  listOpeningLines,
  journalLinesPage,
  journalStatuses,
  ledgerLinesPage,
  listDimensionTypes,
  listDimensionValues,
  queryLedger,
  type JournalExportCursor,
  type LedgerExportCursor,
} from '../../modules/accounting/index.js';
import { getBatch, listRows, type ExportDomainKey } from '../../modules/data-exchange/index.js';
import { getOrganization } from '../../modules/organizations/index.js';
import {
  getPartyExtras,
  listPartiesPage,
  PartyPermissions,
  type Party,
} from '../../modules/parties/index.js';
import type { ExportRow } from '../../modules/reports/index.js';
import { hasPermission, type AuthorizationContext } from '../authorization.js';
import { importDomains } from './imports/index.js';
import type { ExportCell, ExportDomain, ExportEnv } from './types.js';

/**
 * Export domains (S6-06, S6-26..S6-30). Every export reads through the same service queries and
 * filters as its screen, under the acting user's current permissions. List exports are plain
 * tables whose columns match the import templates (round trip); statement and ledger exports
 * start with a titled preamble (S6-29) that carries the tagged-activity label (Decision 4).
 */

const PAGE = 1000;
const num = (value: string | null | undefined): ExportCell => ({ number: value ?? null });
const day = (value: string | null | undefined): ExportCell => ({ date: value ?? null });
const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const today = (now: Date) => now.toISOString().slice(0, 10);
const noParams = z.object({}).strict();

async function organizationName(env: ExportEnv) {
  return (await getOrganization(env.tx, env.ctx.organizationId))?.name ?? '';
}

/** Report preamble: label/value rows, then a blank row before the table. */
async function preamble(env: ExportEnv, title: string, lines: [string, string | null][]) {
  await env.write(['Organization', await organizationName(env)]);
  await env.write(['Report', title]);
  for (const [label, value] of lines) if (value !== null) await env.write([label, value]);
  await env.write(['Generated at', env.now.toISOString()]);
  await env.write([]);
}

function dimensionLabel(filter: readonly { typeName: string; valueName: string }[]) {
  return filter.length
    ? `${filter.map((d) => `${d.typeName}: ${d.valueName}`).join('; ')} (tagged activity only)`
    : null;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const chartOfAccounts: ExportDomain = {
  key: 'chart_of_accounts',
  label: 'Chart of accounts',
  params: noParams,
  permission: async () => AccountingPermissions.AccountsView,
  snapshot: false,
  fileName: (_p, now) => `chart-of-accounts-${today(now)}.csv`,
  async generate(env) {
    const accounts = await env.services.accounting.listAccountsInTransaction(env.tx, env.ctx);
    const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
    await env.write([
      'code',
      'name',
      'type',
      'parent_code',
      'currency',
      'subtype',
      'is_monetary',
      'description',
      'status',
      'is_control_account',
    ]);
    for (const a of accounts) {
      await env.write([
        a.code,
        a.name,
        a.accountType.toLowerCase(),
        a.parentId ? (codeOf.get(a.parentId) ?? null) : null,
        a.currencyCode,
        a.subtype?.toLowerCase() ?? null,
        yesNo(a.isMonetary),
        a.description || null,
        a.status.toLowerCase(),
        yesNo(a.isControlAccount),
      ]);
    }
    return accounts.length;
  },
};

const partiesParams = z
  .object({
    layout: z.enum(['parties', 'contacts']).default('parties'),
    status: z.enum(['active', 'archived', 'all']).default('all'),
  })
  .strict();

const ADDRESS_PARTS = ['line1', 'line2', 'city', 'region', 'postal_code', 'country'] as const;

const partiesExport: ExportDomain<z.infer<typeof partiesParams>> = {
  key: 'parties',
  label: 'Contacts (parties)',
  params: partiesParams,
  permission: async () => PartyPermissions.View,
  snapshot: false,
  fileName: (p, now) =>
    `${p.layout === 'contacts' ? 'contact-persons' : 'contacts'}-${today(now)}.csv`,
  async generate(env, params) {
    if (params.layout === 'parties') {
      await env.write([
        'kind',
        'display_name',
        'company_name',
        'first_name',
        'last_name',
        'reference',
        'tin',
        'email',
        'phone',
        'website',
        'notes',
        'roles',
        'contact_first_name',
        'contact_last_name',
        'contact_job_title',
        'contact_email',
        'contact_phone',
        'contact_mobile',
        ...ADDRESS_PARTS.map((p) => `billing_${p}`),
        ...ADDRESS_PARTS.map((p) => `delivery_${p}`),
        'status',
      ]);
    } else {
      await env.write([
        'party_reference',
        'party_display_name',
        'first_name',
        'last_name',
        'job_title',
        'email',
        'phone',
        'mobile',
        'is_primary',
        'receives_documents',
      ]);
    }
    let after: { name: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page: Party[] = await listPartiesPage(env.tx, env.ctx.organizationId, {
        after,
        limit: 500,
      });
      if (page.length === 0) break;
      const last = page.at(-1)!;
      after = { name: last.displayName.toLowerCase(), id: last.id };
      const selected = page.filter(
        (p) =>
          params.status === 'all' ||
          p.status === (params.status === 'active' ? 'ACTIVE' : 'ARCHIVED'),
      );
      const extras = await getPartyExtras(
        env.tx,
        env.ctx.organizationId,
        selected.map((p) => p.id),
      );
      for (const party of selected) {
        const contacts = extras.contacts.filter((c) => c.partyId === party.id);
        if (params.layout === 'contacts') {
          for (const c of contacts) {
            await env.write([
              party.reference,
              party.displayName,
              c.firstName,
              c.lastName,
              c.jobTitle,
              c.email,
              c.phone,
              c.mobile,
              yesNo(c.isPrimary),
              yesNo(c.receivesDocuments),
            ]);
            count += 1;
          }
          continue;
        }
        const primary = contacts.find((c) => c.isPrimary) ?? null;
        const address = (kind: 'billing' | 'delivery') => {
          const all = extras.addresses.filter((a) => a.partyId === party.id && a.kind === kind);
          const a = all.find((x) => x.isDefault) ?? all[0];
          return a
            ? [a.line1, a.line2, a.city, a.region, a.postalCode, a.countryCode]
            : [null, null, null, null, null, null];
        };
        await env.write([
          party.kind,
          party.displayName,
          party.companyName,
          party.firstName,
          party.lastName,
          party.reference,
          party.tin,
          party.email,
          party.phone,
          party.website,
          party.notes,
          (extras.roles.get(party.id) ?? []).sort().join(';') || null,
          primary?.firstName ?? null,
          primary?.lastName ?? null,
          primary?.jobTitle ?? null,
          primary?.email ?? null,
          primary?.phone ?? null,
          primary?.mobile ?? null,
          ...address('billing'),
          ...address('delivery'),
          party.status.toLowerCase(),
        ]);
        count += 1;
      }
    }
    return count;
  },
};

const dimensionValuesExport: ExportDomain = {
  key: 'dimension_values',
  label: 'Dimension values',
  params: noParams,
  permission: async () => AccountingPermissions.DimensionsView,
  snapshot: false,
  fileName: (_p, now) => `dimension-values-${today(now)}.csv`,
  async generate(env) {
    const types = new Map(
      (await listDimensionTypes(env.tx, env.ctx.organizationId)).map((t) => [t.id, t]),
    );
    const values = await listDimensionValues(env.tx, env.ctx.organizationId);
    await env.write(['dimension', 'code', 'name', 'status']);
    for (const v of values) {
      await env.write([
        types.get(v.dimensionTypeId)?.code ?? null,
        v.code,
        v.name,
        v.status.toLowerCase(),
      ]);
    }
    return values.length;
  },
};

const journalsParams = z
  .object({
    // Dimension columns only when asked for; needs accounting.dimensions.view (Decision 91).
    includeDimensions: z.boolean().default(false),
    statuses: z
      .array(z.enum(journalStatuses))
      .min(1)
      .max(journalStatuses.length)
      .default(['POSTED', 'REVERSED']),
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

const journalsExport: ExportDomain<z.infer<typeof journalsParams>> = {
  key: 'journals',
  label: 'Journals',
  params: journalsParams,
  permission: async () => AccountingPermissions.JournalsView,
  snapshot: true,
  fileName: (_p, now) => `journals-${today(now)}.csv`,
  async generate(env, params) {
    // Decision 91: dimension values are shown only to holders of accounting.dimensions.view.
    const withDimensions =
      params.includeDimensions && hasPermission(env.ctx, AccountingPermissions.DimensionsView);
    const types = withDimensions
      ? (await listDimensionTypes(env.tx, env.ctx.organizationId)).filter(
          (t) => t.status === 'ACTIVE',
        )
      : [];
    await env.write([
      'journal_key',
      'date',
      'currency',
      'exchange_rate',
      'description',
      'reference',
      'account_code',
      'line_description',
      'debit',
      'credit',
      ...types.map((t) => t.name),
      'status',
      'journal_number',
      'account_name',
      'base_debit',
      'base_credit',
    ]);
    let after: JournalExportCursor | null = null;
    let count = 0;
    for (;;) {
      const page = await journalLinesPage(env.tx, env.ctx.organizationId, {
        statuses: params.statuses,
        fromDate: params.fromDate ?? null,
        toDate: params.toDate ?? null,
        includeDimensions: withDimensions,
        after,
        limit: PAGE,
      });
      if (page.length === 0) break;
      for (const l of page) {
        const dims = new Map(
          (l.dimensions ?? '')
            .split('; ')
            .filter(Boolean)
            .map((pair) => pair.split('=') as [string, string]),
        );
        await env.write([
          l.journalNumber !== null ? String(l.journalNumber) : l.journalId,
          day(l.entryDate),
          l.currency,
          num(l.exchangeRate),
          l.description || null,
          l.reference || null,
          l.accountCode,
          l.lineDescription || null,
          num(l.debit),
          num(l.credit),
          ...types.map((t) => dims.get(t.code) ?? null),
          l.status.toLowerCase(),
          l.journalNumber !== null ? String(l.journalNumber) : null,
          l.accountName,
          num(l.baseDebit),
          num(l.baseCredit),
        ]);
        count += 1;
      }
      const last = page.at(-1)!;
      after = { createdAt: last.createdAt, id: last.journalId, lineNumber: last.lineNumber };
    }
    return count;
  },
};

// ---------------------------------------------------------------------------
// Ledger and statements (report layout)
// ---------------------------------------------------------------------------

const ledgerParams = ledgerQuery.omit({ limit: true }).strict();

const generalLedgerExport: ExportDomain<z.infer<typeof ledgerParams>> = {
  key: 'general_ledger',
  label: 'General ledger',
  params: ledgerParams,
  permission: async () => AccountingPermissions.LedgerView,
  snapshot: true,
  fileName: (_p, now) => `general-ledger-${today(now)}.csv`,
  async generate(env, params) {
    const scope = await env.services.accounting.ledgerScopeInTransaction(env.tx, env.ctx, params);
    const dimensionValueIds = scope.dimensionFilter.map((d) => d.dimensionValueId);
    const summary = await queryLedger(env.tx, {
      organizationId: env.ctx.organizationId,
      accountIds: scope.accountIds,
      openingFrom: scope.openingFrom,
      dimensionValueIds,
      fromDate: params.fromDate ?? null,
      toDate: params.toDate ?? null,
      limit: 0,
    });
    await preamble(env, 'General ledger', [
      ['Account', scope.account ? `${scope.account.code} ${scope.account.name}` : 'All accounts'],
      ['From', params.fromDate ?? null],
      ['To', params.toDate ?? null],
      ['Opening basis', scope.account ? scope.openingBasis : null],
      ['Base currency', scope.baseCurrency],
      ['Dimension filter', dimensionLabel(scope.dimensionFilter)],
    ]);
    const running = scope.account !== undefined;
    await env.write([
      'date',
      'journal_number',
      'journal_description',
      'account_code',
      'account_name',
      'line_description',
      'currency',
      'debit',
      'credit',
      'exchange_rate',
      'base_debit',
      'base_credit',
      ...(running ? ['running_balance'] : []),
    ]);
    let balance = decimal(summary.openingBalance ?? '0');
    if (running) {
      await env.write([
        null,
        null,
        'Opening balance',
        null,
        null,
        null,
        scope.baseCurrency,
        null,
        null,
        null,
        null,
        null,
        num(fixedAmount(balance)),
      ]);
    }
    let after: LedgerExportCursor | null = null;
    let count = 0;
    for (;;) {
      const page = await ledgerLinesPage(env.tx, env.ctx.organizationId, {
        accountIds: scope.accountIds,
        dimensionValueIds,
        fromDate: params.fromDate ?? null,
        toDate: params.toDate ?? null,
        after,
        limit: PAGE,
      });
      if (page.length === 0) break;
      for (const l of page) {
        balance = balance.plus(decimal(l.baseDebit ?? '0')).minus(decimal(l.baseCredit ?? '0'));
        await env.write([
          day(l.entryDate),
          String(l.journalNumber),
          l.journalDescription || null,
          l.accountCode,
          l.accountName,
          l.lineDescription || null,
          l.currency,
          num(l.debit),
          num(l.credit),
          num(l.exchangeRate),
          num(l.baseDebit),
          num(l.baseCredit),
          ...(running ? [num(fixedAmount(balance))] : []),
        ]);
        count += 1;
      }
      const last = page.at(-1)!;
      after = {
        entryDate: last.entryDate,
        journalNumber: last.journalNumber,
        lineNumber: last.lineNumber,
      };
    }
    await env.write([
      null,
      null,
      'Total',
      null,
      null,
      null,
      scope.baseCurrency,
      null,
      null,
      null,
      num(summary.totals.baseDebit),
      num(summary.totals.baseCredit),
      ...(running ? [num(fixedAmount(balance))] : []),
    ]);
    return count;
  },
};

async function writeStatement(
  env: ExportEnv,
  columns: { key: string; label: string }[],
  rows: readonly ExportRow[],
) {
  await env.write(['section', 'code', 'name', 'level', ...columns.map((c) => c.label)]);
  for (const r of rows) {
    await env.write([
      r.section,
      r.code,
      `${'  '.repeat(Math.max(0, r.level))}${r.name}`,
      num(String(r.level)),
      ...columns.map((c) => num(r.values[c.key] ?? null)),
    ]);
  }
  return rows.length;
}

const TB_COLUMNS = [
  { key: 'openingDebit', label: 'Opening debit' },
  { key: 'openingCredit', label: 'Opening credit' },
  { key: 'periodDebit', label: 'Period debit' },
  { key: 'periodCredit', label: 'Period credit' },
  { key: 'closingDebit', label: 'Closing debit' },
  { key: 'closingCredit', label: 'Closing credit' },
];

function statementLines(result: {
  baseCurrency: string;
  currencyView: string;
  dimensionFilter: { typeName: string; valueName: string }[];
  integrity: { status: string };
  warnings: { message: string }[];
}): [string, string | null][] {
  return [
    ['Base currency', result.baseCurrency],
    ['Currency view', result.currencyView],
    ['Dimension filter', dimensionLabel(result.dimensionFilter)],
    ['Integrity', result.integrity.status === 'OUT_OF_BALANCE' ? 'OUT OF BALANCE' : null],
    ...result.warnings.map((w): [string, string] => ['Warning', w.message]),
  ];
}

const trialBalanceExport: ExportDomain<z.infer<typeof trialBalanceQuery>> = {
  key: 'trial_balance',
  label: 'Trial Balance',
  params: trialBalanceQuery,
  permission: async () => AccountingPermissions.ReportsView,
  snapshot: true,
  fileName: (_p, now) => `trial-balance-${today(now)}.csv`,
  async generate(env, params) {
    const r = await env.services.reports.trialBalanceInTransaction(env.tx, env.ctx, params);
    await preamble(env, 'Trial Balance', [
      ['Period', `${r.from} to ${r.to}`],
      ['Fiscal year', r.fiscalYear.name],
      ...statementLines(r),
    ]);
    return writeStatement(env, TB_COLUMNS, r.exportRows);
  },
};

const profitAndLossExport: ExportDomain<z.infer<typeof profitAndLossQuery>> = {
  key: 'profit_and_loss',
  label: 'Profit & Loss',
  params: profitAndLossQuery,
  permission: async () => AccountingPermissions.ReportsView,
  snapshot: true,
  fileName: (_p, now) => `profit-and-loss-${today(now)}.csv`,
  async generate(env, params) {
    const r = await env.services.reports.profitAndLossInTransaction(env.tx, env.ctx, params);
    await preamble(env, 'Profit & Loss', [
      ['Period', r.columns.map((c) => c.label).join(' | ')],
      ...statementLines(r),
    ]);
    return writeStatement(env, r.columns, r.exportRows);
  },
};

const balanceSheetExport: ExportDomain<z.infer<typeof balanceSheetQuery>> = {
  key: 'balance_sheet',
  label: 'Balance Sheet',
  params: balanceSheetQuery,
  permission: async () => AccountingPermissions.ReportsView,
  snapshot: true,
  fileName: (_p, now) => `balance-sheet-${today(now)}.csv`,
  async generate(env, params) {
    const r = await env.services.reports.balanceSheetInTransaction(env.tx, env.ctx, params);
    await preamble(env, 'Balance Sheet', [
      ['As of', r.columns.map((c) => c.label).join(' | ')],
      ...statementLines(r),
    ]);
    return writeStatement(env, r.columns, r.exportRows);
  },
};

// ---------------------------------------------------------------------------
// Import error report
// ---------------------------------------------------------------------------

const errorReportParams = z.object({ batchId: z.uuid() }).strict();

/** The batch's domain permission; creators keep access to their own batch's report. */
async function batchPermission(tx: Transaction, ctx: AuthorizationContext, batchId: string) {
  const batch = await getBatch(tx, ctx.organizationId, batchId);
  if (!batch) throw new NotFoundError('Import not found.');
  const permission = importDomains.get(batch.domain)!.permission;
  if (batch.createdByUserId !== ctx.userId && !hasPermission(ctx, permission)) {
    throw new PermissionDeniedError();
  }
  return permission;
}

const importErrorsExport: ExportDomain<z.infer<typeof errorReportParams>> = {
  key: 'import_errors',
  label: 'Import error report',
  params: errorReportParams,
  permission: async (params, env) => batchPermission(env.tx, env.ctx, params.batchId),
  snapshot: false,
  fileName: (_p, now) => `import-errors-${today(now)}.csv`,
  async generate(env, params) {
    const batch = await getBatch(env.tx, env.ctx.organizationId, params.batchId);
    if (!batch) throw new NotFoundError('Import not found.');
    const columns = batch.columns ?? [];
    await env.write(['row', 'status', 'excluded', 'field', 'code', 'message', ...columns]);
    let after = 0;
    let count = 0;
    for (;;) {
      const page = await listRows(env.tx, env.ctx.organizationId, batch.id, {
        statuses: ['error', 'warning'],
        after,
        limit: PAGE,
      });
      if (page.length === 0) break;
      for (const row of page) {
        const cells = columns.map((_, i) => row.raw?.[i] ?? null);
        for (const m of row.messages) {
          await env.write([
            num(String(row.rowNumber)),
            m.severity,
            yesNo(row.excluded),
            m.field,
            m.code,
            m.message,
            ...cells,
          ]);
          count += 1;
        }
      }
      after = page.at(-1)!.rowNumber;
    }
    return count;
  },
};

/**
 * Opening balances (S8-16): the lines of a batch (default: the open batch, else the latest) in
 * the import's columns, so an export re-imports as a template. Dimension columns only for
 * holders of accounting.dimensions.view (Decision 91).
 */
const openingBalancesExport: ExportDomain<{ batchId?: string | undefined }> = {
  key: 'opening_balances',
  label: 'Opening balances',
  params: z.object({ batchId: z.uuid().optional() }).strict(),
  permission: async () => AccountingPermissions.JournalsView,
  snapshot: false,
  fileName: (_p, now) => `opening-balances-${today(now)}.csv`,
  async generate(env, params) {
    const organizationId = env.ctx.organizationId;
    const batch = params.batchId
      ? await getOpeningBatch(env.tx, organizationId, params.batchId)
      : ((await findOpenOpeningBatch(env.tx, organizationId)) ??
        (await listOpeningBatches(env.tx, organizationId))[0]);
    if (params.batchId && !batch) throw new NotFoundError('Opening batch not found.');
    const withDimensions = hasPermission(env.ctx, AccountingPermissions.DimensionsView);
    const types = withDimensions
      ? (await listDimensionTypes(env.tx, organizationId)).filter((t) => t.status === 'ACTIVE')
      : [];
    const values = withDimensions
      ? new Map((await listDimensionValues(env.tx, organizationId)).map((v) => [v.id, v]))
      : new Map();
    await env.write([
      'Account',
      'Account name',
      'Currency',
      'Debit',
      'Credit',
      'Base amount',
      'Description',
      ...types.map((t) => t.code),
    ]);
    if (!batch) return 0;
    const accounts = new Map((await listAccounts(env.tx, organizationId)).map((a) => [a.id, a]));
    const lines = await listOpeningLines(env.tx, organizationId, batch.id);
    for (const line of lines) {
      const account = accounts.get(line.accountId);
      await env.write([
        account?.code ?? null,
        account?.name ?? null,
        account?.currencyCode ?? null,
        { number: line.debit === null ? null : fixedAmount(decimal(line.debit)) },
        { number: line.credit === null ? null : fixedAmount(decimal(line.credit)) },
        { number: line.baseAmount === null ? null : fixedAmount(decimal(line.baseAmount)) },
        line.description,
        ...types.map((t) => {
          const assigned = line.dimensions.find((d) => d.dimensionTypeId === t.id);
          return assigned ? (values.get(assigned.dimensionValueId)?.code ?? null) : null;
        }),
      ]);
    }
    return lines.length;
  },
};

export const exportDomains: ReadonlyMap<ExportDomainKey, ExportDomain<never>> = new Map(
  (
    [
      chartOfAccounts,
      partiesExport,
      dimensionValuesExport,
      journalsExport,
      generalLedgerExport,
      trialBalanceExport,
      profitAndLossExport,
      balanceSheetExport,
      importErrorsExport,
      openingBalancesExport,
    ] as ExportDomain<never>[]
  ).map((d) => [d.key, d]),
);
