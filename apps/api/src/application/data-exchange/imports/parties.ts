import { createPartyBody } from '../../../api/v1/parties.routes.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { listCountries } from '../../../modules/organizations/index.js';
import {
  listPartyMatchKeys,
  PartyPermissions,
  partyKinds,
  partyRoles,
  type PartyRole,
} from '../../../modules/parties/index.js';
import type { CreatePartyInput } from '../../party-service.js';
import { Collector, field, outcome, zodMessages } from '../helpers.js';
import type { ImportDomain, ImportField, RowOutcome } from '../types.js';

/**
 * Parties import (S6-20): one row per party with its primary contact person and a billing and a
 * delivery address. S4 rules apply unchanged: display name (S4-08), unique reference (S4-09,
 * an error), active countries (S4-05), duplicate hints as warnings only (S4-13).
 */

const KIND_ALIASES: Record<string, 'organization' | 'individual'> = {
  organization: 'organization',
  organisation: 'organization',
  company: 'organization',
  business: 'organization',
  individual: 'individual',
  person: 'individual',
};

const CONTACT_FIELDS = [
  ['contact_first_name', 'firstName', 'Contact first name', 'Aisha'],
  ['contact_last_name', 'lastName', 'Contact last name', 'Ibrahim'],
  ['contact_job_title', 'jobTitle', 'Contact job title', 'Finance Manager'],
  ['contact_email', 'email', 'Contact email', 'aisha@example.com'],
  ['contact_phone', 'phone', 'Contact phone', '+960 330 0000'],
  ['contact_mobile', 'mobile', 'Contact mobile', '+960 777 0000'],
] as const;

const ADDRESS_PARTS = [
  ['line1', 'line1', 'line 1', 'Orchid Magu'],
  ['line2', 'line2', 'line 2', 'Floor 3'],
  ['city', 'city', 'city', 'Malé'],
  ['region', 'region', 'region / atoll', 'Kaafu'],
  ['postal_code', 'postalCode', 'postal code', '20026'],
  ['country', 'countryCode', 'country', 'MV'],
] as const;

const HEADER_FIELDS: Record<string, string> = {
  kind: 'kind',
  displayName: 'display_name',
  companyName: 'company_name',
  firstName: 'first_name',
  lastName: 'last_name',
  reference: 'reference',
  tin: 'tin',
  email: 'email',
  phone: 'phone',
  website: 'website',
  notes: 'notes',
  roles: 'roles',
};

/** Maps a createPartyBody path (e.g. "addresses.1.line1") back to the import field key. */
function fieldOfPath(
  path: string,
  addressKinds: readonly ('billing' | 'delivery')[],
): string | null {
  const [head, index, leaf] = path.split('.');
  if (head === 'contacts') {
    const found = CONTACT_FIELDS.find((f) => f[1] === leaf);
    return found ? found[0] : 'contact_first_name';
  }
  if (head === 'addresses') {
    const kind = addressKinds[Number(index)] ?? 'billing';
    const found = ADDRESS_PARTS.find((p) => p[1] === leaf);
    return `${kind}_${found ? found[0] : 'line1'}`;
  }
  return head ? (HEADER_FIELDS[head] ?? null) : null;
}

const normalizedName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export const partiesImport: ImportDomain = {
  key: 'parties',
  label: 'Contacts (parties)',
  permission: PartyPermissions.Create,
  groupsRows: false,

  async fields() {
    const fields: ImportField[] = [
      field('kind', 'Kind', {
        required: true,
        description: 'organization or individual.',
        example: 'organization',
        synonyms: ['type', 'party type', 'contact type'],
      }),
      field('display_name', 'Display name', {
        description: 'Required for organizations; individuals default to "first last".',
        example: 'Blue Lagoon Traders',
        synonyms: ['name', 'contact name', 'customer name', 'supplier name', 'vendor name'],
      }),
      field('company_name', 'Company name', {
        description: 'Legal or company name.',
        example: 'Blue Lagoon Traders Pvt Ltd',
        synonyms: ['company', 'legal name', 'business name'],
      }),
      field('first_name', 'First name', {
        description: 'For individuals.',
        example: 'Aisha',
        synonyms: ['given name'],
      }),
      field('last_name', 'Last name', {
        description: 'For individuals.',
        example: 'Ibrahim',
        synonyms: ['surname', 'family name'],
      }),
      field('reference', 'Reference', {
        description: 'Your own code for the party; unique (not case-sensitive).',
        example: 'C-001',
        synonyms: ['code', 'account number', 'customer code', 'supplier code', 'contact code'],
      }),
      field('tin', 'TIN', {
        description: 'Tax identification number.',
        example: '1001234GST501',
        synonyms: ['tax id', 'tax number', 'vat number', 'gst number'],
      }),
      field('email', 'Email', {
        description: 'Main email address.',
        example: 'accounts@bluelagoon.mv',
        synonyms: ['email address', 'e-mail'],
      }),
      field('phone', 'Phone', {
        description: 'Main phone number.',
        example: '+960 330 1234',
        synonyms: ['telephone', 'phone number'],
      }),
      field('website', 'Website', {
        description: 'Web address.',
        example: 'https://bluelagoon.mv',
        synonyms: ['web', 'url'],
      }),
      field('notes', 'Notes', {
        description: 'Up to 2000 characters.',
        example: 'Pays on delivery',
        synonyms: ['note', 'memo', 'comments'],
      }),
      field('roles', 'Roles', {
        description: 'Any of customer, vendor, employee, other, separated by ";".',
        example: 'customer;vendor',
        synonyms: ['role', 'party roles'],
      }),
    ];
    for (const [key, , label, example] of CONTACT_FIELDS) {
      fields.push(
        field(key, label, { description: 'Primary contact person.', example, synonyms: [] }),
      );
    }
    for (const kind of ['billing', 'delivery'] as const) {
      const title = kind === 'billing' ? 'Billing' : 'Delivery';
      for (const [part, , label, example] of ADDRESS_PARTS) {
        fields.push(
          field(`${kind}_${part}`, `${title} ${label}`, {
            description:
              part === 'country'
                ? '2-letter ISO country code; required when the address is given.'
                : part === 'line1'
                  ? 'Required when the address is given.'
                  : `${title} address.`,
            example,
            synonyms: part === 'postal_code' ? [`${kind} zip`, `${kind} postcode`] : [],
          }),
        );
      }
    }
    return fields;
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const countries = new Map((await listCountries(tx)).map((c) => [c.code, c]));
    const keys = await listPartyMatchKeys(tx, ctx.organizationId);
    const references = new Set(keys.map((k) => k.reference).filter((r): r is string => r !== null));
    const active = keys.filter((k) => k.status === 'ACTIVE');
    const names = new Set(active.map((k) => k.name));
    const tins = new Set(active.map((k) => k.tin).filter(Boolean));
    const emails = new Set(active.map((k) => k.email).filter(Boolean));

    const count = (values: (string | null)[]) => {
      const m = new Map<string, number>();
      for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
      return m;
    };
    const cell = (row: (typeof rows)[number], key: string) =>
      normalize.text(row.values[key] ?? null);
    const fileRefs = count(rows.map((r) => cell(r, 'reference')?.toLowerCase() ?? null));

    const results: RowOutcome[] = [];
    const seenNames = new Map<string, number>();
    const seenTins = new Map<string, number>();
    const seenEmails = new Map<string, number>();
    for (const row of rows) {
      const c = new Collector();
      const v = (k: string) => cell(row, k);
      const rawKind = v('kind');
      const kind =
        rawKind === null
          ? c.require(null, 'kind', 'Kind')
          : (KIND_ALIASES[normalize.matchKey(rawKind)] ??
            c.take(normalize.oneOf(rawKind, partyKinds, 'kind'), null));
      const roles: PartyRole[] = [];
      for (const r of normalize.list(v('roles'))) {
        const role = c.take(normalize.oneOf(r, partyRoles, 'roles'), null);
        if (role && !roles.includes(role)) roles.push(role);
      }
      const contactValues = Object.fromEntries(CONTACT_FIELDS.map(([key, prop]) => [prop, v(key)]));
      const hasContact = Object.values(contactValues).some((x) => x !== null);
      const addressKinds: ('billing' | 'delivery')[] = [];
      const addresses = [];
      for (const kindOfAddress of ['billing', 'delivery'] as const) {
        const parts = Object.fromEntries(
          ADDRESS_PARTS.map(([part, prop]) => [prop, v(`${kindOfAddress}_${part}`)]),
        ) as Record<string, string | null>;
        if (Object.values(parts).every((x) => x === null)) continue;
        addressKinds.push(kindOfAddress);
        addresses.push({
          kind: kindOfAddress,
          label: null,
          ...parts,
          line1: parts.line1 ?? '',
          countryCode: parts.countryCode?.toUpperCase() ?? '',
          isDefault: true,
        });
      }
      if (c.failed) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const checked = createPartyBody.safeParse({
        kind,
        displayName: v('display_name'),
        companyName: v('company_name'),
        firstName: v('first_name'),
        lastName: v('last_name'),
        reference: v('reference'),
        tin: v('tin'),
        email: v('email'),
        phone: v('phone'),
        website: v('website'),
        notes: v('notes'),
        roles,
        contacts: hasContact
          ? [{ ...contactValues, isPrimary: true, receivesDocuments: false }]
          : [],
        addresses,
      });
      if (!checked.success) {
        c.messages.push(...zodMessages(checked.error, (p) => fieldOfPath(p, addressKinds)));
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const party = checked.data as CreatePartyInput;
      // S4-08: display name required; an individual defaults to "first last".
      const displayName =
        party.displayName ??
        (party.kind === 'individual'
          ? [party.firstName, party.lastName].filter(Boolean).join(' ').trim() || null
          : null);
      if (!displayName) {
        c.error(
          'REQUIRED',
          'display_name',
          party.kind === 'individual'
            ? 'Enter a display name or a first or last name.'
            : 'A display name is required.',
        );
      }
      party.addresses.forEach((a, i) => {
        const country = countries.get(a.countryCode);
        const key = `${addressKinds[i]}_country`;
        if (!country) c.error('INVALID_VALUE', key, 'Unknown country.');
        else if (!country.isActive)
          c.error('INVALID_VALUE', key, 'This country is no longer available.');
      });
      const ref = party.reference?.toLowerCase() ?? null;
      if (ref && (fileRefs.get(ref) ?? 0) > 1) {
        c.error(
          'DUPLICATE_IN_FILE',
          'reference',
          'This reference appears more than once in the file.',
        );
      } else if (ref && references.has(ref)) {
        c.error('ALREADY_EXISTS', 'reference', 'Another party already uses this reference.');
      }
      // S4-13: possible duplicates are reported, never blocked.
      if (displayName) {
        const name = normalizedName(displayName);
        const tin = party.tin?.toLowerCase() ?? null;
        const email = party.email?.toLowerCase() ?? null;
        const matches = [
          names.has(name) || seenNames.has(name) ? 'name' : null,
          tin && (tins.has(tin) || seenTins.has(tin)) ? 'TIN' : null,
          email && (emails.has(email) || seenEmails.has(email)) ? 'email' : null,
        ].filter(Boolean);
        if (matches.length) {
          c.warning(
            'POSSIBLE_DUPLICATE',
            null,
            `Another party (existing or earlier in the file) has the same ${matches.join(', ')}.`,
          );
        }
        seenNames.set(name, row.rowNumber);
        if (tin) seenTins.set(tin, row.rowNumber);
        if (email) seenEmails.set(email, row.rowNumber);
      }
      results.push(outcome(row.rowNumber, { ...party, displayName }, c.messages));
    }
    return results;
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const party = await env.services.parties.createInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as CreatePartyInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: party.id });
    }
    return results;
  },
};
