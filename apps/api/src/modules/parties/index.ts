/**
 * Public contract of the parties module: the unified Party/Contact master (Decisions 8, 28).
 * Customers (3B) and later modules reference parties through this contract and never write the
 * party tables directly.
 */
export * from './parties.js';
export * from './permissions.js';
export { partyAddressKinds, partyKinds, partyRoles, partyStatuses } from './schema.js';
export type { PartyAddressKind, PartyKind, PartyRole, PartyStatus } from './schema.js';
