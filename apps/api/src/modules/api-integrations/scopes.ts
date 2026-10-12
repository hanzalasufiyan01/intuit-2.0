/**
 * The fixed platform Public API policy for v1 (ADR 0011, D1 and D2): the scope catalog, what each
 * scope maps to in the existing permission catalog, and the token lifetime ceiling. There is no
 * per-organization API policy. Scope names are public compatibility contracts: they may be added
 * but never renamed, removed or widened.
 *
 * Writes are limited to the D1 draft resources, so no scope maps to a permission that issues,
 * posts, records, voids, refunds, reverses, approves, or changes settings.
 */

export interface PublicApiScope {
  scope: string;
  description: string;
  /** Existing organization permission keys this scope stands for. */
  permissions: readonly string[];
  write: boolean;
}

export const PUBLIC_API_SCOPES: readonly PublicApiScope[] = [
  {
    scope: 'customers:read',
    description: 'Read customers',
    permissions: ['customers.view'],
    write: false,
  },
  {
    scope: 'customers:write',
    description: 'Create and update customers',
    permissions: ['customers.create', 'customers.update'],
    write: true,
  },
  // `items:read` is deliberately absent: the catalog has no separate view permission (viewing
  // items is allowed by invoices.view, bills.view or the manage keys), so a read-only scope would
  // have to widen into invoice or bill access. It can be added when the catalog gets a view key.
  {
    scope: 'items:write',
    description: 'Create and update items (there is no public item read)',
    permissions: ['catalog.items.manage'],
    write: true,
  },
  {
    scope: 'vendors:read',
    description: 'Read vendors',
    permissions: ['vendors.view'],
    write: false,
  },
  {
    scope: 'invoices:read',
    description: 'Read invoices',
    permissions: ['invoices.view'],
    write: false,
  },
  {
    scope: 'invoices:write',
    description: 'Create and edit draft invoices (never issue or void them)',
    permissions: ['invoices.create', 'invoices.edit_draft'],
    write: true,
  },
  {
    scope: 'bills:read',
    description: 'Read bills',
    permissions: ['bills.view'],
    write: false,
  },
  {
    scope: 'accounts:read',
    description: 'Read the chart of accounts',
    permissions: ['accounting.accounts.view'],
    write: false,
  },
];

const BY_SCOPE = new Map(PUBLIC_API_SCOPES.map((s) => [s.scope, s]));

/** Tokens live at most this long (ADR 0011 section 2). */
export const MAX_TOKEN_LIFETIME_DAYS = 365;
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;
/** At most this many active tokens per organization. */
export const MAX_ACTIVE_TOKENS_PER_ORGANIZATION = 10;

export function isPublicApiScope(scope: string): boolean {
  return BY_SCOPE.has(scope);
}

/** The permission keys behind scopes; unknown scopes (not in the platform policy) give nothing. */
export function permissionsForScopes(scopes: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const scope of scopes) {
    for (const key of BY_SCOPE.get(scope)?.permissions ?? []) keys.add(key);
  }
  return keys;
}
