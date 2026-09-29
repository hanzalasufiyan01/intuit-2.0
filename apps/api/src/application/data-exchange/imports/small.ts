import { contactBody } from '../../../api/v1/parties.routes.js';
import { dimensionValueBody, rateBody } from '../../../api/v1/accounting.routes.js';
import { isSupportedCurrency, parseRate } from '../../../domain/money.js';
import {
  AccountingPermissions,
  exchangeRateKeys,
  listDimensionTypes,
  listDimensionValues,
} from '../../../modules/accounting/index.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { listPartyMatchKeys, PartyPermissions } from '../../../modules/parties/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import type { ContactInput } from '../../party-service.js';
import { Collector, field, outcome, zodMessages } from '../helpers.js';
import type { ImportDomain, RowOutcome } from '../types.js';

// ---------------------------------------------------------------------------
// Party contacts (L-2; permission parties.update: adding a contact updates the party)
// ---------------------------------------------------------------------------

const CONTACT_FIELD_OF: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  jobTitle: 'job_title',
  email: 'email',
  phone: 'phone',
  mobile: 'mobile',
  isPrimary: 'is_primary',
  receivesDocuments: 'receives_documents',
};

export const partyContactsImport: ImportDomain = {
  key: 'party_contacts',
  label: 'Contact persons',
  permission: PartyPermissions.Update,
  groupsRows: false,

  async fields() {
    return [
      field('party_reference', 'Party reference', {
        required: true,
        description: 'Reference of an existing party (not case-sensitive).',
        example: 'C-001',
        synonyms: ['reference', 'party', 'customer code', 'supplier code', 'contact code'],
      }),
      field('first_name', 'First name', {
        description: 'First or last name is required.',
        example: 'Aisha',
        synonyms: ['given name'],
      }),
      field('last_name', 'Last name', {
        description: 'First or last name is required.',
        example: 'Ibrahim',
        synonyms: ['surname', 'family name'],
      }),
      field('job_title', 'Job title', {
        description: 'Role at the party.',
        example: 'Finance Manager',
        synonyms: ['title', 'position'],
      }),
      field('email', 'Email', {
        description: 'Email address.',
        example: 'aisha@example.com',
        synonyms: ['email address', 'e-mail'],
      }),
      field('phone', 'Phone', {
        description: 'Phone number.',
        example: '+960 330 0000',
        synonyms: ['telephone'],
      }),
      field('mobile', 'Mobile', {
        description: 'Mobile number.',
        example: '+960 777 0000',
        synonyms: ['cell', 'mobile phone'],
      }),
      field('is_primary', 'Primary', {
        description: 'yes/no. Replaces the current primary contact.',
        example: 'no',
        synonyms: ['primary contact'],
      }),
      field('receives_documents', 'Receives documents', {
        description: 'yes/no.',
        example: 'yes',
        synonyms: ['documents'],
      }),
    ];
  },

  async validate(env, rows) {
    const keys = await listPartyMatchKeys(env.tx, env.ctx.organizationId);
    const byReference = new Map(
      keys.filter((k) => k.reference !== null).map((k) => [k.reference!, k.id]),
    );
    const primaries = new Map<string, number>();
    const results: RowOutcome[] = [];
    for (const row of rows) {
      const c = new Collector();
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const reference = c.require(v('party_reference'), 'party_reference', 'Party reference');
      const partyId = reference ? byReference.get(reference.toLowerCase()) : undefined;
      if (reference && !partyId) {
        c.error('UNKNOWN_PARTY', 'party_reference', 'No party has this reference.');
      }
      const isPrimary = c.take(normalize.boolean(v('is_primary'), 'is_primary'), null) ?? false;
      const receivesDocuments =
        c.take(normalize.boolean(v('receives_documents'), 'receives_documents'), null) ?? false;
      if (c.failed) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const checked = contactBody.safeParse({
        firstName: v('first_name'),
        lastName: v('last_name'),
        jobTitle: v('job_title'),
        email: v('email'),
        phone: v('phone'),
        mobile: v('mobile'),
        isPrimary,
        receivesDocuments,
      });
      if (!checked.success) {
        c.messages.push(...zodMessages(checked.error, (p) => CONTACT_FIELD_OF[p] ?? null));
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      if (isPrimary && partyId) {
        if (primaries.has(partyId)) {
          c.error(
            'DUPLICATE_IN_FILE',
            'is_primary',
            'Only one contact per party can be primary in the file.',
          );
        }
        primaries.set(partyId, row.rowNumber);
      }
      results.push(outcome(row.rowNumber, { partyId, contact: checked.data }, c.messages));
    }
    return results;
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const { partyId, contact } = row.normalized as { partyId: string; contact: ContactInput };
      const created = await env.services.parties.addContactInTransaction(
        env.tx,
        env.ctx,
        partyId,
        contact,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: created.id });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// Dimension values (L-2; types are created manually, Decision 89 scope rules)
// ---------------------------------------------------------------------------

export const dimensionValuesImport: ImportDomain = {
  key: 'dimension_values',
  label: 'Dimension values',
  permission: AccountingPermissions.DimensionsManage,
  groupsRows: false,

  async fields() {
    return [
      field('dimension', 'Dimension', {
        required: true,
        description: 'Code or name of an existing, active dimension type.',
        example: 'PROJECT',
        synonyms: ['dimension type', 'type', 'category', 'tracking category'],
      }),
      field('code', 'Code', {
        required: true,
        description:
          'Value code: 1-20 letters, digits, ".", "_" or "-"; unique within the dimension.',
        example: 'P-100',
        synonyms: ['value code'],
      }),
      field('name', 'Name', {
        required: true,
        description: 'Value name, up to 100 characters; unique within the dimension.',
        example: 'Resort renovation',
        synonyms: ['value name', 'value', 'option'],
      }),
    ];
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    await requireAccountingSettings(tx, ctx.organizationId);
    const types = await listDimensionTypes(tx, ctx.organizationId);
    const values = await listDimensionValues(tx, ctx.organizationId);
    const codeKey = (typeId: string, code: string) => `${typeId}|${code}`;
    const nameKey = (typeId: string, name: string) => `${typeId}|${name.trim().toLowerCase()}`;
    const existingCodes = new Set(values.map((x) => codeKey(x.dimensionTypeId, x.code)));
    const existingNames = new Set(values.map((x) => nameKey(x.dimensionTypeId, x.name)));
    const fileCodes = new Map<string, number>();
    const fileNames = new Map<string, number>();
    const prepared = rows.map((row) => {
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const ref = v('dimension');
      const type = ref
        ? (types.find((t) => t.code === ref) ??
          types.find((t) => t.name.toLowerCase() === ref.toLowerCase()))
        : undefined;
      const code = v('code');
      const name = v('name');
      if (type && code)
        fileCodes.set(codeKey(type.id, code), (fileCodes.get(codeKey(type.id, code)) ?? 0) + 1);
      if (type && name)
        fileNames.set(nameKey(type.id, name), (fileNames.get(nameKey(type.id, name)) ?? 0) + 1);
      return { row, ref, type, code, name };
    });
    return prepared.map(({ row, ref, type, code, name }) => {
      const c = new Collector();
      c.require(ref, 'dimension', 'Dimension');
      if (ref && !type)
        c.error('UNKNOWN_DIMENSION', 'dimension', 'No dimension type has this code or name.');
      else if (type && type.status !== 'ACTIVE') {
        c.error('ARCHIVED', 'dimension', 'Values cannot be added to an archived dimension.');
      }
      const checked = dimensionValueBody.safeParse({ code, name });
      if (!checked.success) {
        c.messages.push(
          ...zodMessages(checked.error, (p) => (p === 'code' || p === 'name' ? p : null)),
        );
      } else if (type) {
        const k = codeKey(type.id, checked.data.code);
        const n = nameKey(type.id, checked.data.name);
        if ((fileCodes.get(k) ?? 0) > 1)
          c.error(
            'DUPLICATE_IN_FILE',
            'code',
            'This code appears more than once for the dimension.',
          );
        else if (existingCodes.has(k))
          c.error(
            'ALREADY_EXISTS',
            'code',
            'A value with this code already exists for this dimension.',
          );
        if ((fileNames.get(n) ?? 0) > 1)
          c.error(
            'DUPLICATE_IN_FILE',
            'name',
            'This name appears more than once for the dimension.',
          );
        else if (existingNames.has(n))
          c.error(
            'ALREADY_EXISTS',
            'name',
            'A value with this name already exists for this dimension.',
          );
      }
      return outcome(
        row.rowNumber,
        checked.success && type ? { typeId: type.id, ...checked.data } : null,
        c.messages,
      );
    });
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const { typeId, code, name } = row.normalized as {
        typeId: string;
        code: string;
        name: string;
      };
      const value = await env.services.dimensions.createValueInTransaction(
        env.tx,
        env.ctx,
        typeId,
        { code, name },
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: value.id });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// Exchange rates (L-2; accounting.setup, the key of recordExchangeRate)
// ---------------------------------------------------------------------------

export const exchangeRatesImport: ImportDomain = {
  key: 'exchange_rates',
  label: 'Exchange rates',
  permission: AccountingPermissions.Setup,
  groupsRows: false,

  async fields() {
    return [
      field('currency', 'Currency', {
        required: true,
        description:
          'Foreign currency (3-letter ISO code); the rate converts it to the base currency.',
        example: 'USD',
        synonyms: ['from currency', 'currency code', 'ccy'],
      }),
      field('date', 'Date', {
        required: true,
        description: 'Date the rate applies from, in the chosen date format.',
        example: '2026-01-31',
        synonyms: ['rate date', 'effective date'],
      }),
      field('rate', 'Rate', {
        required: true,
        description: 'Base-currency units per 1 unit of the currency (up to 10 decimals).',
        example: '15.42',
        synonyms: ['exchange rate', 'fx rate'],
      }),
    ];
  },

  async validate(env, rows) {
    const { tx, ctx, options } = env;
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const existing = await exchangeRateKeys(tx, ctx.organizationId, settings.baseCurrency);
    const inFile = new Map<string, number>();
    const prepared = rows.map((row) => {
      const c = new Collector();
      const v = (k: string) => normalize.text(row.values[k] ?? null);
      const currency = c.require(v('currency'), 'currency', 'Currency')?.toUpperCase() ?? null;
      const date = c.take(
        normalize.date(c.require(v('date'), 'date', 'Date'), options.dateFormat, 'date'),
        null,
      );
      const rate = c.take(
        normalize.decimal(c.require(v('rate'), 'rate', 'Rate'), options.decimalSeparator, 'rate'),
        null,
      );
      if (currency && date)
        inFile.set(`${currency}|${date}`, (inFile.get(`${currency}|${date}`) ?? 0) + 1);
      return { row, c, currency, date, rate };
    });
    return prepared.map(({ row, c, currency, date, rate }) => {
      if (c.failed) return outcome(row.rowNumber, null, c.messages);
      const checked = rateBody.safeParse({ fromCurrency: currency, rateDate: date, rate });
      if (!checked.success) {
        c.messages.push(
          ...zodMessages(checked.error, (p) =>
            p === 'fromCurrency'
              ? 'currency'
              : p === 'rateDate'
                ? 'date'
                : p === 'rate'
                  ? 'rate'
                  : null,
          ),
        );
        return outcome(row.rowNumber, null, c.messages);
      }
      const input = checked.data;
      if (!isSupportedCurrency(input.fromCurrency))
        c.error('INVALID_VALUE', 'currency', 'Unsupported currency.');
      else if (input.fromCurrency === settings.baseCurrency) {
        c.error(
          'INVALID_VALUE',
          'currency',
          'Rates are recorded for foreign currencies against the base currency.',
        );
      }
      if (!parseRate(input.rate).ok) {
        c.error(
          'INVALID_VALUE',
          'rate',
          'Rates are positive decimal strings with at most 10 decimals.',
        );
      }
      const key = `${input.fromCurrency}|${input.rateDate}`;
      if ((inFile.get(key) ?? 0) > 1)
        c.error('DUPLICATE_IN_FILE', 'date', 'This currency and date appear more than once.');
      else if (existing.has(key))
        c.error('ALREADY_EXISTS', 'date', 'A rate for this currency and date already exists.');
      return outcome(row.rowNumber, { ...input }, c.messages);
    });
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const rate = await env.services.accounting.recordExchangeRateInTransaction(
        env.tx,
        env.ctx,
        row.normalized as { fromCurrency: string; rateDate: string; rate: string },
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: rate.id });
    }
    return results;
  },
};
