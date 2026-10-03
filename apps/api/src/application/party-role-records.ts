import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import type { EventOrigin } from '../modules/audit/index.js';
import { getParty, type Party, type PartyRole } from '../modules/parties/index.js';
import type { AuthorizationContext } from './authorization.js';
import type { CreatePartyInput, PartyService } from './party-service.js';

/**
 * Business records that hang off the shared Party master through a role (Decisions 8, 28; R36):
 * a customer (Sales, `customer` role) or a vendor (Purchases, `vendor` role; ADR 0004 P4-03).
 * Identity, contacts and addresses stay on the Party; each module owns its own record table and
 * permissions. These helpers hold the Party-side steps those modules share, so the role-record
 * rules are written once. Neutral and behaviour-preserving: the Customer messages are the Phase 3B
 * ones (`noun` = "customer").
 */

export interface PartyRoleRecordKind {
  role: PartyRole;
  /** Lower-case noun used in messages, e.g. "customer". */
  noun: string;
}

/** Keyset cursor over a party listing ordered by (lower(display name), id). */
export function encodePartyCursor(party: Party): string {
  return Buffer.from(JSON.stringify({ n: party.displayName.toLowerCase(), i: party.id })).toString(
    'base64url',
  );
}

export function decodePartyCursor(cursor: string): { name: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      n?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.n === 'string' &&
      typeof parsed.i === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.i)
    ) {
      return { name: parsed.n, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
}

/**
 * The party a new role record is created for: an existing active party, which gains the role if
 * it lacks it (other roles are kept, so one party can be a customer and a vendor), or a new party
 * created with the role. Runs the Party rules and audit under the record's create permission.
 */
export async function partyForRoleRecord(
  parties: PartyService,
  tx: Transaction,
  ctx: AuthorizationContext,
  input: { partyId: string; party?: undefined } | { party: CreatePartyInput; partyId?: undefined },
  options: {
    kind: PartyRoleRecordKind;
    permission: string;
    /** Whether the party already has a record of this kind. */
    hasRecord: (partyId: string) => Promise<boolean>;
    origin: EventOrigin;
  },
): Promise<{ party: Party; newParty: boolean }> {
  const { kind, permission, origin } = options;
  if (input.partyId !== undefined) {
    const existing = await getParty(tx, ctx.organizationId, input.partyId, { forUpdate: true });
    if (!existing) throw new NotFoundError('Party not found.');
    if (existing.status !== 'ACTIVE') {
      throw new ValidationError([
        { path: 'partyId', message: 'Restore the archived contact first.' },
      ]);
    }
    if (await options.hasRecord(existing.id)) {
      throw new ConflictError('CONFLICT', `This contact is already a ${kind.noun}.`);
    }
    const detail = await parties.detailInTransaction(tx, ctx.organizationId, existing.id);
    const party = detail.roles.includes(kind.role)
      ? existing
      : await parties.updateInTransaction(
          tx,
          ctx,
          existing.id,
          { version: existing.version, roles: [...detail.roles, kind.role] },
          origin,
          { permission },
        );
    return { party, newParty: false };
  }
  const roles: PartyRole[] = [...new Set([...input.party.roles, kind.role])];
  const party = await parties.createInTransaction(
    tx,
    ctx,
    { ...input.party, roles },
    origin,
    permission,
  );
  return { party, newParty: true };
}

/** The identity fields a role record's detail shows from its party. */
export async function partyIdentity(
  parties: PartyService,
  tx: Transaction,
  organizationId: string,
  partyId: string,
) {
  const party = await parties.detailInTransaction(tx, organizationId, partyId);
  const row = await getParty(tx, organizationId, partyId);
  return {
    row: row!,
    extra: {
      website: party.website,
      notes: party.notes,
      firstName: party.firstName,
      lastName: party.lastName,
      roles: party.roles,
      contacts: party.contacts,
      addresses: party.addresses,
    },
  };
}

/** A role record is restored only while its party is active. */
export async function assertPartyActiveForRestore(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  kind: PartyRoleRecordKind,
) {
  const party = await getParty(tx, organizationId, partyId);
  if (party?.status !== 'ACTIVE') {
    throw new ConflictError(
      'INVALID_STATE_TRANSITION',
      `Restore the archived contact before restoring the ${kind.noun}.`,
    );
  }
}
