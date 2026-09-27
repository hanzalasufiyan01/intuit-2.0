/** Contract for system role templates from which every organization's roles are provisioned. */
export interface RoleTemplateDefinition {
  key: string;
  name: string;
  description: string;
  isOwner: boolean;
  sortOrder: number;
  /** `'all'` grants the entire catalog (kept in sync as modules add permissions). */
  permissions: 'all' | readonly string[];
}

export const RoleTemplateKeys = {
  Owner: 'owner',
  Administrator: 'administrator',
  Member: 'member',
} as const;
