import { decimal } from '../../../domain/money.js';
import {
  AccountingPermissions,
  findOpenOpeningBatch,
  listAccounts,
  listDimensionTypes,
  listDimensionValues,
  type OpeningLineInput,
} from '../../../modules/accounting/index.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import { hasPermission } from '../../authorization.js';
import { Collector, field, outcome } from '../helpers.js';
import type { ImportDomain, ImportField } from '../types.js';

/**
 * Opening balances import (S8-16). Rows become the lines of the organization's DRAFT opening
 * batch (one is created when none is open), replacing its lines. It never posts: posting always
 * goes through the opening-balance post endpoint with approval, re-authentication and full
 * re-validation. Every opening-balance line rule applies (S8-05 to S8-09).
 */
const DIMENSION_PREFIX = 'dimension:';

/** Maps a service issue path (`lines.<i>.<field>`) to the import field. */
function fieldOf(path: string): string | null {
  const name = path.split('.')[2];
  if (name === 'accountId') return 'account';
  if (name === 'debit' || name === 'credit') return name;
  if (name === 'baseAmount') return 'base_amount';
  return null;
}

export const openingBalancesImport: ImportDomain = {
  key: 'opening_balances',
  label: 'Opening balances',
  // Decision 65: opening balances need accounting.setup.
  permission: AccountingPermissions.Setup,
  groupsRows: false,

  async fields(env) {
    const fields: ImportField[] = [
      field('account', 'Account', {
        required: true,
        description: 'Account code of a balance-sheet (or, mid-year, income/expense) account.',
        example: '1110',
        synonyms: ['account code', 'code', 'gl code', 'account number'],
      }),
      field('debit', 'Debit', {
        description: "Positive balance in the account's currency; fill either debit or credit.",
        example: '25000.00',
        synonyms: ['dr', 'debit balance'],
      }),
      field('credit', 'Credit', {
        description: "Positive balance in the account's currency; fill either debit or credit.",
        example: '',
        synonyms: ['cr', 'credit balance'],
      }),
      field('base_amount', 'Base amount', {
        description:
          'Foreign-currency accounts only: the carrying value in the base currency. Give it on ' +
          'every line of that currency or on none (then the rate table is used).',
        example: '',
        synonyms: ['base', 'base value', 'carrying value', 'local amount'],
      }),
      field('description', 'Description', {
        description: 'Optional note for the line.',
        example: 'Balance per prior system',
        synonyms: ['memo', 'narration', 'details'],
      }),
    ];
    for (const type of await listDimensionTypes(env.tx, env.ctx.organizationId)) {
      if (type.status !== 'ACTIVE') continue;
      fields.push(
        field(`${DIMENSION_PREFIX}${type.code}`, type.name, {
          description: `Code or name of an active ${type.name} value${type.isRequired ? ' (required for some accounts)' : ''}.`,
          example: '',
          synonyms: [type.code, `dimension ${type.name}`, `dimension ${type.code}`],
        }),
      );
    }
    return fields;
  },

  async validate(env, rows) {
    const { tx, ctx, options, services } = env;
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const open = await findOpenOpeningBatch(tx, ctx.organizationId);
    const blocked = !settings.conversionDate
      ? 'Set the conversion date before importing opening balances.'
      : open && open.status !== 'DRAFT'
        ? open.status === 'POSTED'
          ? 'Opening balances are already posted; reverse the opening batch before importing.'
          : 'The opening batch is awaiting approval; withdraw it before importing.'
        : null;
    const accountList = await listAccounts(tx, ctx.organizationId);
    const accounts = new Map(accountList.map((a) => [a.code, a]));
    const types = await listDimensionTypes(tx, ctx.organizationId);
    const values = await listDimensionValues(tx, ctx.organizationId);
    const mayAssign = hasPermission(ctx, AccountingPermissions.DimensionsView);

    const parsed = rows.map((row) => {
      const c = new Collector();
      if (blocked) c.error('BATCH_NOT_EDITABLE', null, blocked);
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const code = c.require(v('account'), 'account', 'Account');
      const account = code ? accounts.get(code) : undefined;
      if (code && !account) c.error('UNKNOWN_ACCOUNT', 'account', 'No account has this code.');
      const debit = c.take(normalize.decimal(v('debit'), options.decimalSeparator, 'debit'), null);
      const credit = c.take(
        normalize.decimal(v('credit'), options.decimalSeparator, 'credit'),
        null,
      );
      const baseAmount = c.take(
        normalize.decimal(v('base_amount'), options.decimalSeparator, 'base_amount'),
        null,
      );
      for (const [name, amount] of [
        ['debit', debit],
        ['credit', credit],
        ['base_amount', baseAmount],
      ] as const) {
        if (amount !== null && !decimal(amount).gt(0)) {
          c.error(
            'INVALID_AMOUNT',
            name,
            name === 'base_amount'
              ? 'Base amounts are positive.'
              : 'Amounts are positive; use the other column instead of a negative amount.',
          );
        }
      }
      if ((debit === null) === (credit === null)) {
        c.error('INVALID_AMOUNT', 'debit', 'Fill exactly one of debit or credit.');
      }
      const dimensions: OpeningLineInput['dimensions'] = [];
      for (const [fieldKey, raw] of Object.entries(row.values)) {
        if (!fieldKey.startsWith(DIMENSION_PREFIX)) continue;
        const cell = normalize.text(raw);
        if (cell === null) continue;
        const type = types.find((t) => t.code === fieldKey.slice(DIMENSION_PREFIX.length));
        if (!type) continue;
        if (!mayAssign) {
          c.error(
            'DIMENSION_PERMISSION',
            fieldKey,
            'You need permission to view dimensions to assign dimension values.',
          );
          continue;
        }
        const value =
          values.find((x) => x.dimensionTypeId === type.id && x.code === cell) ??
          values.find(
            (x) => x.dimensionTypeId === type.id && x.name.toLowerCase() === cell.toLowerCase(),
          );
        if (!value) {
          c.error(
            'UNKNOWN_DIMENSION_VALUE',
            fieldKey,
            `No ${type.name} value has this code or name.`,
          );
        } else {
          dimensions.push({ dimensionTypeId: type.id, dimensionValueId: value.id });
        }
      }
      const line: OpeningLineInput | null =
        account && !c.failed
          ? {
              accountId: account.id,
              description: (v('description') ?? '').slice(0, 500),
              debit,
              credit,
              baseAmount,
              dimensions,
            }
          : null;
      return { row, c, line };
    });

    // Opening-balance rules on every well-formed row at once (service rules, no writes).
    const candidates = parsed.filter((p) => p.line !== null);
    if (candidates.length > 0 && settings.conversionDate && !blocked) {
      const issues = await services.openingBalances.importIssues(
        tx,
        ctx,
        settings,
        settings.conversionDate,
        candidates.map((p) => p.line!),
      );
      for (const issue of issues) {
        const index = Number(issue.path.split('.')[1]);
        const target = Number.isInteger(index) ? candidates[index] : undefined;
        if (target) target.c.error('INVALID_VALUE', fieldOf(issue.path), issue.message);
        else for (const p of candidates) p.c.error('INVALID_VALUE', null, issue.message);
      }
    }
    return parsed.map(({ row, c, line }) =>
      outcome(row.rowNumber, line ? { ...line } : null, c.messages),
    );
  },

  async commit(env, rows, context) {
    const lines = rows.map((row) => row.normalized as unknown as OpeningLineInput);
    const saved = await env.services.openingBalances.replaceLinesFromImportInTransaction(
      env.tx,
      env.ctx,
      lines,
      context.origin,
      context.batchId,
    );
    return rows.map((row, i) => ({ rowNumber: row.rowNumber, recordId: saved[i]!.id }));
  },
};
