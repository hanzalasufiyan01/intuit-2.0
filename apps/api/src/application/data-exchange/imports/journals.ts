import { AppError, PermissionDeniedError, ValidationError } from '../../../domain/errors.js';
import { decimal, type Money } from '../../../domain/money.js';
import {
  AccountingPermissions,
  journalDuplicateKeys,
  listAccounts,
  listDimensionTypes,
  listDimensionValues,
  listPeriods,
} from '../../../modules/accounting/index.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import { hasPermission } from '../../authorization.js';
import type { JournalInput } from '../../journal-service.js';
import { Collector, field, outcome } from '../helpers.js';
import type { ImportDomain, ImportField, MappedRow, RowOutcome } from '../types.js';

/**
 * Draft manual journal import (L-2, S6-15..S6-17). Rows sharing a journal key form one journal.
 * Every S1/S2 manual-journal rule applies through JournalService (single currency and rate,
 * R33; no base-only lines or base amounts; control accounts rejected; Decision 11 currencies;
 * dimensions per Decisions 78, 84-92). Imported journals are DRAFTs carrying the batch as their
 * source (L-8); nothing is submitted, approved or posted.
 */

const DIMENSION_PREFIX = 'dimension:';

interface JournalHeader {
  entryDate: string;
  currency: string;
  exchangeRate: string | null;
  description: string;
  reference: string;
}

interface JournalLineRow {
  accountId: string;
  description: string;
  debit: string | null;
  credit: string | null;
  dimensions: { dimensionTypeId: string; dimensionValueId: string }[];
}

const HEADER_KEYS = ['date', 'currency', 'exchange_rate', 'description', 'reference'] as const;

/** Where a JournalService issue path points in the file. */
function lineField(leaf: string | undefined): string {
  switch (leaf) {
    case 'accountId':
      return 'account_code';
    case 'debit':
      return 'debit';
    case 'credit':
      return 'credit';
    case 'description':
      return 'line_description';
    default:
      return 'account_code';
  }
}

function headerField(path: string): string | null {
  if (path === 'entryDate') return 'date';
  if (path === 'exchangeRate') return 'exchange_rate';
  if (path === 'currency') return 'currency';
  if (path === 'reference') return 'reference';
  if (path === 'description') return 'description';
  return null;
}

export const journalsImport: ImportDomain = {
  key: 'manual_journals',
  label: 'Manual journals (drafts)',
  permission: AccountingPermissions.JournalsCreate,
  groupsRows: true,

  async fields(env) {
    const fields: ImportField[] = [
      field('journal_key', 'Journal key', {
        required: true,
        description: 'Rows with the same key form one journal (for example JE-001).',
        example: 'JE-001',
        synonyms: ['journal', 'journal no', 'journal number', 'entry', 'entry no', 'voucher'],
      }),
      field('date', 'Date', {
        required: true,
        description: 'Journal date, in the chosen date format. The period is checked at posting.',
        example: '2026-03-15',
        synonyms: ['entry date', 'journal date', 'posting date', 'transaction date'],
      }),
      field('currency', 'Currency', {
        description: 'Journal currency (3-letter ISO code). Defaults to the base currency.',
        example: 'MVR',
        synonyms: ['currency code', 'ccy'],
      }),
      field('exchange_rate', 'Exchange rate', {
        description: 'For a foreign-currency journal; otherwise the rate table applies at posting.',
        example: '15.42',
        synonyms: ['rate', 'fx rate'],
      }),
      field('description', 'Journal description', {
        description: 'Up to 1000 characters.',
        example: 'Opening float',
        synonyms: ['narration', 'memo', 'journal memo'],
      }),
      field('reference', 'Reference', {
        description: 'Up to 100 characters.',
        example: 'INV-2026-001',
        synonyms: ['ref', 'document number'],
      }),
      field('account_code', 'Account code', {
        required: true,
        description: 'Code of the account on this line.',
        example: '1110',
        synonyms: ['account', 'gl code', 'account number', 'code'],
      }),
      field('line_description', 'Line description', {
        description: 'Up to 500 characters.',
        example: 'Cash sale',
        synonyms: ['line memo', 'line narration', 'details'],
      }),
      field('debit', 'Debit', {
        description: 'Positive amount; fill either debit or credit.',
        example: '250.00',
        synonyms: ['dr', 'debit amount'],
      }),
      field('credit', 'Credit', {
        description: 'Positive amount; fill either debit or credit.',
        example: '',
        synonyms: ['cr', 'credit amount'],
      }),
    ];
    for (const type of await listDimensionTypes(env.tx, env.ctx.organizationId)) {
      if (type.status !== 'ACTIVE') continue;
      fields.push(
        field(`${DIMENSION_PREFIX}${type.code}`, type.name, {
          required: false,
          description: `Code or name of an active ${type.name} value${type.isRequired ? ' (required for some accounts at posting)' : ''}.`,
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
    const accountList = await listAccounts(tx, ctx.organizationId);
    const accounts = new Map(accountList.map((a) => [a.code, a]));
    const accountsById = new Map(accountList.map((a) => [a.id, a]));
    const types = await listDimensionTypes(tx, ctx.organizationId);
    const values = await listDimensionValues(tx, ctx.organizationId);
    const periods = await listPeriods(tx, ctx.organizationId);
    const mayAssign = hasPermission(ctx, AccountingPermissions.DimensionsView);

    // 1. Per-row parsing.
    interface Parsed {
      row: MappedRow;
      c: Collector;
      key: string | null;
      header: Record<(typeof HEADER_KEYS)[number], string | null>;
      line: JournalLineRow | null;
      amount: Money;
    }
    const parsed: Parsed[] = rows.map((row) => {
      const c = new Collector();
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const key = c.require(v('journal_key'), 'journal_key', 'Journal key');
      if (key && key.length > 200)
        c.error('TOO_LONG', 'journal_key', 'Journal keys are at most 200 characters.');
      const header = {
        date: c.take(normalize.date(v('date'), options.dateFormat, 'date'), null),
        currency: v('currency')?.toUpperCase() ?? null,
        exchange_rate: c.take(
          normalize.decimal(v('exchange_rate'), options.decimalSeparator, 'exchange_rate'),
          null,
        ),
        description: v('description'),
        reference: v('reference'),
      };
      const code = c.require(v('account_code'), 'account_code', 'Account code');
      const account = code ? accounts.get(code) : undefined;
      if (code && !account) c.error('UNKNOWN_ACCOUNT', 'account_code', 'No account has this code.');
      const debit = c.take(normalize.decimal(v('debit'), options.decimalSeparator, 'debit'), null);
      const credit = c.take(
        normalize.decimal(v('credit'), options.decimalSeparator, 'credit'),
        null,
      );
      for (const [name, amount] of [
        ['debit', debit],
        ['credit', credit],
      ] as const) {
        if (amount !== null && !decimal(amount).gt(0)) {
          c.error(
            'INVALID_AMOUNT',
            name,
            'Amounts are positive; use the other column instead of a negative amount.',
          );
        }
      }
      if ((debit === null) === (credit === null)) {
        c.error('INVALID_AMOUNT', 'debit', 'Fill exactly one of debit or credit.');
      }
      const dimensions: JournalLineRow['dimensions'] = [];
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
        if (!value)
          c.error(
            'UNKNOWN_DIMENSION_VALUE',
            fieldKey,
            `No ${type.name} value has this code or name.`,
          );
        else if (value.status !== 'ACTIVE' || type.status !== 'ACTIVE') {
          // Decision 88: archived values are never newly assigned.
          c.error(
            'ARCHIVED_VALUE',
            fieldKey,
            `This ${type.name} value is archived and cannot be assigned.`,
          );
        } else dimensions.push({ dimensionTypeId: type.id, dimensionValueId: value.id });
      }
      const line =
        account && !c.failed
          ? {
              accountId: account.id,
              description: v('line_description') ?? '',
              debit,
              credit,
              dimensions,
            }
          : null;
      return { row, c, key, header, line, amount: decimal(debit ?? '0') };
    });

    // 2. Group into journals (first appearance order) and resolve each header.
    const groups = new Map<string, Parsed[]>();
    for (const p of parsed) {
      if (p.key === null) continue;
      groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
    }
    const headers = new Map<string, JournalHeader>();
    const references = new Set<string>();
    for (const [key, members] of groups) {
      const resolved: Record<string, string | null> = {};
      for (const hk of HEADER_KEYS) {
        const first = members.find((m) => m.header[hk] !== null)?.header[hk] ?? null;
        resolved[hk] = first;
        for (const m of members) {
          if (m.header[hk] !== null && m.header[hk] !== first) {
            m.c.error(
              'INCONSISTENT_JOURNAL',
              hk,
              'Rows of one journal must agree on this value (or leave it blank).',
            );
          }
        }
      }
      if (resolved.date === null) members[0]!.c.error('REQUIRED', 'date', 'Date is required.');
      if (resolved.reference) references.add(resolved.reference);
      headers.set(key, {
        entryDate: resolved.date ?? '',
        currency: resolved.currency ?? settings.baseCurrency,
        exchangeRate: resolved.exchange_rate ?? null,
        description: resolved.description ?? '',
        reference: resolved.reference ?? '',
      });
    }
    const duplicates = await journalDuplicateKeys(tx, ctx.organizationId, [...references]);

    // 3. Journal-level rules, then every manual-journal draft rule through JournalService.
    for (const [key, members] of groups) {
      const header = headers.get(key)!;
      const clean = members.every((m) => !m.c.failed && m.line !== null);
      if (!clean) {
        for (const m of members) {
          if (!m.c.failed)
            m.c.error('JOURNAL_HAS_ERRORS', null, 'Another row of this journal has errors.');
        }
        continue;
      }
      const all = (code: string, fieldKey: string | null, message: string) =>
        members.forEach((m) => m.c.error(code, fieldKey, message));
      if (members.length < 2) {
        all('NOT_ENOUGH_LINES', 'journal_key', 'A journal needs at least two lines.');
        continue;
      }
      const debit = members.reduce((acc, m) => acc.plus(decimal(m.line!.debit ?? '0')), decimal(0));
      const credit = members.reduce(
        (acc, m) => acc.plus(decimal(m.line!.credit ?? '0')),
        decimal(0),
      );
      if (!debit.eq(credit)) {
        all(
          'UNBALANCED_JOURNAL',
          'debit',
          'The journal does not balance: total debits and credits differ.',
        );
        continue;
      }
      const input: JournalInput = { ...header, lines: members.map((m) => m.line!) };
      try {
        await services.journals.validateDraftInTransaction(tx, ctx, input);
      } catch (error) {
        if (error instanceof ValidationError) {
          for (const issue of error.details?.issues ?? []) {
            const match = /^lines\.(\d+)(?:\.(\w+))?/.exec(issue.path);
            if (match && members[Number(match[1])]) {
              members[Number(match[1])]!.c.error(
                'INVALID_VALUE',
                lineField(match[2]),
                issue.message,
              );
            } else {
              all('INVALID_VALUE', headerField(issue.path), issue.message);
            }
          }
        } else if (error instanceof PermissionDeniedError) {
          all('DIMENSION_PERMISSION', null, error.message);
        } else if (error instanceof AppError) {
          all(error.code, null, error.message);
        } else {
          throw error;
        }
        continue;
      }
      // Warnings: enforced later (at submit/post), reported now.
      const period = periods.find(
        (p) => p.startDate <= header.entryDate && header.entryDate <= p.endDate,
      );
      if (!period || period.status !== 'OPEN') {
        members[0]!.c.warning(
          'PERIOD_NOT_OPEN',
          'date',
          'No open accounting period covers this date; the journal cannot be posted until one does.',
        );
      }
      if (header.reference) {
        const dupKey = `${header.reference.toLowerCase()}|${header.entryDate}|${debit.toFixed(4)}`;
        if (duplicates.has(dupKey)) {
          members[0]!.c.warning(
            'POSSIBLE_DUPLICATE',
            'reference',
            'A journal with the same reference, date and total already exists.',
          );
        }
      }
      for (const m of members) {
        const account = accountsById.get(m.line!.accountId)!;
        for (const type of types) {
          if (type.status !== 'ACTIVE' || !type.isRequired) continue;
          const inScope =
            type.scopeAccountTypes.includes(account.accountType) ||
            (account.subtype !== null && type.scopeAccountSubtypes.includes(account.subtype));
          if (inScope && !m.line!.dimensions.some((d) => d.dimensionTypeId === type.id)) {
            m.c.warning(
              'REQUIRED_DIMENSION_MISSING',
              `${DIMENSION_PREFIX}${type.code}`,
              `${type.name} is required for this account; add it before the journal is submitted.`,
            );
          }
        }
      }
    }

    return parsed.map((p): RowOutcome =>
      outcome(
        p.row.rowNumber,
        p.key && p.line ? { header: headers.get(p.key), line: p.line } : null,
        p.c.messages,
        p.key,
      ),
    );
  },

  async commit(env, rows, context) {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.groupKey!;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const results: { rowNumber: number; recordId: string }[] = [];
    for (const members of groups.values()) {
      const ordered = [...members].sort((a, b) => a.rowNumber - b.rowNumber);
      const header = (ordered[0]!.normalized as { header: JournalHeader }).header;
      const input: JournalInput = {
        ...header,
        lines: ordered.map((r) => (r.normalized as { line: JournalLineRow }).line),
      };
      const journal = await env.services.journals.createJournalInTransaction(
        env.tx,
        env.ctx,
        input,
        context.origin,
        { sourceRef: { module: 'data_exchange', type: 'import_batch', id: context.batchId } },
      );
      for (const r of ordered) results.push({ rowNumber: r.rowNumber, recordId: journal.id });
    }
    return results.sort((a, b) => a.rowNumber - b.rowNumber);
  },
};
