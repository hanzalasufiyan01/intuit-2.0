import { accountBody } from '../../../api/v1/accounting.routes.js';
import { isSupportedCurrency } from '../../../domain/money.js';
import {
  AccountingPermissions,
  accountSubtypes,
  accountTypes,
  designationsOfAccount,
  isAccountReferencedOutsideDrafts,
  listAccounts,
  resolveMonetary,
  subtypeMatchesType,
  type AccountSubtype,
  type AccountType,
} from '../../../modules/accounting/index.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import { Collector, field, outcome, zodMessages } from '../helpers.js';
import type { ImportDomain, RowOutcome } from '../types.js';

/**
 * Chart of accounts import (S6-19). Exactly the rules of account creation (B-series, Decisions
 * 1, 53, 54, 70): designations, control-account status and system settings are not importable
 * (Decisions 14, 79, 82). Parents are referenced by code and may appear later in the file.
 */

interface AccountRow {
  code: string;
  name: string;
  description: string;
  type: AccountType;
  parentCode: string | null;
  currencyCode: string;
  subtype: AccountSubtype | null;
  isMonetary: boolean | undefined;
}

/** Common spellings of the five account natures. */
const TYPE_ALIASES: Record<string, AccountType> = {
  asset: 'ASSET',
  assets: 'ASSET',
  liability: 'LIABILITY',
  liabilities: 'LIABILITY',
  equity: 'EQUITY',
  revenue: 'REVENUE',
  income: 'REVENUE',
  expense: 'EXPENSE',
  expenses: 'EXPENSE',
};

const FIELD_OF: Record<string, string> = {
  code: 'code',
  name: 'name',
  description: 'description',
  type: 'type',
  currencyCode: 'currency',
  subtype: 'subtype',
  isMonetary: 'is_monetary',
};

export const accountsImport: ImportDomain = {
  key: 'chart_of_accounts',
  label: 'Chart of accounts',
  permission: AccountingPermissions.AccountsCreate,
  groupsRows: false,

  async fields() {
    return [
      field('code', 'Code', {
        required: true,
        description: 'Unique account code: 1-20 letters, digits, ".", "_" or "-".',
        example: '1150',
        synonyms: ['account code', 'gl code', 'account number', 'number', 'acct', 'account no'],
      }),
      field('name', 'Name', {
        required: true,
        description: 'Account name, up to 200 characters.',
        example: 'Petty Cash',
        synonyms: ['account name', 'account', 'title'],
      }),
      field('type', 'Type', {
        required: true,
        description: 'Asset, Liability, Equity, Revenue (or Income) or Expense.',
        example: 'Asset',
        synonyms: ['account type', 'nature', 'category', 'class'],
      }),
      field('parent_code', 'Parent code', {
        description: 'Code of the parent account (an existing account or one in this file).',
        example: '1100',
        synonyms: ['parent', 'parent account', 'parent account code'],
      }),
      field('currency', 'Currency', {
        description: '3-letter ISO currency code. Defaults to the base currency.',
        example: 'MVR',
        synonyms: ['currency code', 'ccy'],
      }),
      field('subtype', 'Subtype', {
        description: `Optional classification: ${accountSubtypes.map((s) => s.toLowerCase()).join(', ')}.`,
        example: 'cash',
        synonyms: ['sub type', 'detail type', 'classification'],
      }),
      field('is_monetary', 'Monetary', {
        description: 'yes/no. Only where the subtype allows it; defaults from the subtype.',
        example: 'yes',
        synonyms: ['monetary'],
      }),
      field('description', 'Description', {
        description: 'Up to 1000 characters.',
        example: 'Cash kept at the front desk',
        synonyms: ['notes', 'memo'],
      }),
    ];
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const existing = new Map((await listAccounts(tx, ctx.organizationId)).map((a) => [a.code, a]));
    const inFile = new Map<string, number>();
    for (const row of rows) {
      const code = normalize.text(row.values.code ?? null);
      if (code !== null) inFile.set(code, (inFile.get(code) ?? 0) + 1);
    }

    const parsed = new Map<number, AccountRow>();
    const results = new Map<number, Collector>();
    for (const row of rows) {
      const c = new Collector();
      results.set(row.rowNumber, c);
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const rawType = v('type');
      const type =
        rawType === null
          ? null
          : (TYPE_ALIASES[normalize.matchKey(rawType)] ??
            c.take(normalize.oneOf(rawType, accountTypes, 'type'), null));
      const subtype = c.take(normalize.oneOf(v('subtype'), accountSubtypes, 'subtype'), null);
      const isMonetary = c.take(normalize.boolean(v('is_monetary'), 'is_monetary'), null);
      const input = {
        code: c.require(v('code'), 'code', 'Code'),
        name: c.require(v('name'), 'name', 'Name'),
        description: v('description') ?? '',
        type: type ?? (rawType === null ? c.require(null, 'type', 'Type') : null),
        currencyCode: v('currency')?.toUpperCase() ?? undefined,
        subtype,
        isMonetary: isMonetary ?? undefined,
      };
      if (c.failed) continue;
      const checked = accountBody.omit({ parentId: true }).safeParse(input);
      if (!checked.success) {
        c.messages.push(...zodMessages(checked.error, (p) => FIELD_OF[p] ?? null));
        continue;
      }
      const a = checked.data;
      const currencyCode = a.currencyCode ?? settings.baseCurrency;
      if (!isSupportedCurrency(currencyCode))
        c.error('INVALID_VALUE', 'currency', 'Unsupported currency.');
      if (a.subtype && !subtypeMatchesType(a.subtype, a.type)) {
        c.error('INVALID_VALUE', 'subtype', 'This subtype does not belong to the account type.');
      }
      const monetary = resolveMonetary(a.subtype ?? null, a.isMonetary);
      if (!monetary.ok) c.error('INVALID_VALUE', 'is_monetary', monetary.message);
      if ((inFile.get(a.code) ?? 0) > 1) {
        c.error('DUPLICATE_IN_FILE', 'code', 'This code appears more than once in the file.');
      } else if (existing.has(a.code)) {
        c.error('ALREADY_EXISTS', 'code', 'An account with this code already exists.');
      }
      parsed.set(row.rowNumber, {
        code: a.code,
        name: a.name,
        description: a.description,
        type: a.type,
        parentCode: v('parent_code'),
        currencyCode,
        subtype: a.subtype ?? null,
        isMonetary: a.isMonetary,
      });
    }

    // Parents: an existing account or another row of this file, of the same type, no cycles.
    const byCode = new Map([...parsed].map(([n, r]) => [r.code, { rowNumber: n, row: r }]));
    const parentChecks = new Map<string, Promise<string | null>>();
    const existingParentProblem = (id: string) => {
      if (!parentChecks.has(id)) {
        parentChecks.set(
          id,
          (async () => {
            if (await isAccountReferencedOutsideDrafts(tx, ctx.organizationId, id)) {
              return 'The parent account has journal lines, so it cannot become a parent.';
            }
            if ((await designationsOfAccount(tx, ctx.organizationId, id)).length > 0) {
              return 'A designated system account cannot become a parent.';
            }
            // ADR 0004, P4-08 amendment: an owned control account stays a posting account.
            if ([...existing.values()].some((a) => a.id === id && a.controlSubledger !== null)) {
              return 'A subledger control account cannot become a parent.';
            }
            return null;
          })(),
        );
      }
      return parentChecks.get(id)!;
    };
    for (const [rowNumber, row] of parsed) {
      const c = results.get(rowNumber)!;
      if (row.parentCode === null) continue;
      if (row.parentCode === row.code) {
        c.error('INVALID_PARENT', 'parent_code', 'An account cannot be its own parent.');
        continue;
      }
      const fileParent = byCode.get(row.parentCode);
      const existingParent = existing.get(row.parentCode);
      if (fileParent) {
        if (fileParent.row.type !== row.type) {
          c.error(
            'INVALID_PARENT',
            'parent_code',
            'A parent account must have the same account type.',
          );
        }
        // Walk up the in-file chain to find a cycle.
        const seen = new Set([row.code]);
        let cursor: string | null = row.parentCode;
        while (cursor !== null && byCode.has(cursor)) {
          if (seen.has(cursor)) {
            c.error('CYCLE', 'parent_code', 'The parent codes form a cycle.');
            break;
          }
          seen.add(cursor);
          cursor = byCode.get(cursor)!.row.parentCode;
        }
      } else if (existingParent) {
        if (existingParent.accountType !== row.type) {
          c.error(
            'INVALID_PARENT',
            'parent_code',
            'A parent account must have the same account type.',
          );
        } else {
          const problem = await existingParentProblem(existingParent.id);
          if (problem) c.error('INVALID_PARENT', 'parent_code', problem);
        }
      } else {
        c.error(
          'UNKNOWN_PARENT',
          'parent_code',
          'No account with this parent code exists in the file or the chart.',
        );
      }
    }

    return rows.map((row): RowOutcome => {
      const c = results.get(row.rowNumber)!;
      const account = parsed.get(row.rowNumber);
      return outcome(row.rowNumber, account ? { ...account } : null, c.messages);
    });
  },

  async commit(env, rows, context) {
    const { tx, ctx } = env;
    const existing = new Map(
      (await listAccounts(tx, ctx.organizationId)).map((a) => [a.code, a.id]),
    );
    const pending = new Map(rows.map((r) => [(r.normalized as unknown as AccountRow).code, r]));
    const created = new Map<string, string>();
    const results: { rowNumber: number; recordId: string }[] = [];
    // Parents before children: create a row once its parent exists (validated acyclic).
    const create = async (code: string): Promise<string> => {
      const done = created.get(code) ?? existing.get(code);
      if (done) return done;
      const row = pending.get(code)!;
      const account = row.normalized as unknown as AccountRow;
      const parentId = account.parentCode ? await create(account.parentCode) : null;
      const record = await env.services.accounting.createAccountInTransaction(
        tx,
        ctx,
        {
          code: account.code,
          name: account.name,
          description: account.description,
          type: account.type,
          parentId,
          currencyCode: account.currencyCode,
          subtype: account.subtype,
          isMonetary: account.isMonetary,
        },
        context.origin,
      );
      created.set(code, record.id);
      results.push({ rowNumber: row.rowNumber, recordId: record.id });
      return record.id;
    };
    for (const code of pending.keys()) await create(code);
    return results.sort((a, b) => a.rowNumber - b.rowNumber);
  },
};
