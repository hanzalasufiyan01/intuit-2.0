import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the parties module (Decision 65; S4-16). No delete key exists. */
export const PartyPermissions = {
  View: 'parties.view',
  Create: 'parties.create',
  Update: 'parties.update',
  Archive: 'parties.archive',
} as const;

export const partyPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: PartyPermissions.View,
    module: 'parties',
    description: 'View parties (contacts), their contact persons and addresses',
  },
  { key: PartyPermissions.Create, module: 'parties', description: 'Create parties' },
  {
    key: PartyPermissions.Update,
    module: 'parties',
    description: 'Edit parties, their roles, contact persons and addresses',
  },
  { key: PartyPermissions.Archive, module: 'parties', description: 'Archive and restore parties' },
];
