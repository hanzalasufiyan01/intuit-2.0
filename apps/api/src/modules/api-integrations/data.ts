import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  apiIntegrations,
  apiIntegrationScopes,
  apiTokens,
  type IntegrationStatus,
} from './schema.js';

/** API integration data access (migration 0056). Rules live in the application services. */

export type ApiIntegration = typeof apiIntegrations.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;

const scoped = (organizationId: string, id: string) =>
  and(eq(apiIntegrations.organizationId, organizationId), eq(apiIntegrations.id, id));

export async function insertIntegration(
  tx: Transaction,
  values: typeof apiIntegrations.$inferInsert,
): Promise<ApiIntegration> {
  const [row] = await tx.insert(apiIntegrations).values(values).returning();
  return row!;
}

export async function getIntegration(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ApiIntegration | undefined> {
  const query = tx.select().from(apiIntegrations).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listIntegrations(
  tx: Transaction,
  organizationId: string,
  filter: { status?: IntegrationStatus | undefined } = {},
): Promise<ApiIntegration[]> {
  return tx
    .select()
    .from(apiIntegrations)
    .where(
      and(
        eq(apiIntegrations.organizationId, organizationId),
        filter.status ? eq(apiIntegrations.status, filter.status) : undefined,
      ),
    )
    .orderBy(asc(apiIntegrations.createdAt), asc(apiIntegrations.id));
}

/** Updates at `version` (optimistic concurrency), bumping it. */
export async function updateIntegration(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof apiIntegrations.$inferInsert>;
  },
): Promise<ApiIntegration | undefined> {
  const [row] = await tx
    .update(apiIntegrations)
    .set({ ...input.set, version: sql`${apiIntegrations.version} + 1` })
    .where(and(scoped(input.organizationId, input.id), eq(apiIntegrations.version, input.version)))
    .returning();
  return row;
}

export async function listScopes(
  tx: Transaction,
  organizationId: string,
  integrationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (integrationIds.length === 0) return result;
  const rows = await tx
    .select()
    .from(apiIntegrationScopes)
    .where(
      and(
        eq(apiIntegrationScopes.organizationId, organizationId),
        inArray(apiIntegrationScopes.integrationId, [...integrationIds]),
      ),
    )
    .orderBy(asc(apiIntegrationScopes.scope));
  for (const row of rows) {
    result.set(row.integrationId, [...(result.get(row.integrationId) ?? []), row.scope]);
  }
  return result;
}

export async function addScopes(
  tx: Transaction,
  input: {
    organizationId: string;
    integrationId: string;
    scopes: readonly string[];
    grantedByUserId: string;
    now: Date;
  },
): Promise<void> {
  if (input.scopes.length === 0) return;
  await tx.insert(apiIntegrationScopes).values(
    input.scopes.map((scope) => ({
      integrationId: input.integrationId,
      organizationId: input.organizationId,
      scope,
      grantedByUserId: input.grantedByUserId,
      grantedAt: input.now,
    })),
  );
}

export async function removeScopes(
  tx: Transaction,
  organizationId: string,
  integrationId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return;
  await tx
    .delete(apiIntegrationScopes)
    .where(
      and(
        eq(apiIntegrationScopes.organizationId, organizationId),
        eq(apiIntegrationScopes.integrationId, integrationId),
        inArray(apiIntegrationScopes.scope, [...scopes]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function insertToken(
  tx: Transaction,
  values: typeof apiTokens.$inferInsert,
): Promise<ApiToken | undefined> {
  const [row] = await tx
    .insert(apiTokens)
    .values(values)
    .onConflictDoNothing({ target: apiTokens.publicId })
    .returning();
  return row;
}

export async function getToken(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ApiToken | undefined> {
  const query = tx
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.organizationId, organizationId), eq(apiTokens.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listTokens(
  tx: Transaction,
  organizationId: string,
  integrationId: string,
): Promise<ApiToken[]> {
  return tx
    .select()
    .from(apiTokens)
    .where(
      and(eq(apiTokens.organizationId, organizationId), eq(apiTokens.integrationId, integrationId)),
    )
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
}

/** Tokens that can still authenticate (not revoked, not expired), for the organization cap. */
export async function countActiveTokens(
  tx: Transaction,
  organizationId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.organizationId, organizationId),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, now),
      ),
    );
  return row?.n ?? 0;
}

export async function revokeToken(
  tx: Transaction,
  input: { organizationId: string; id: string; userId: string; reason: string; now: Date },
): Promise<ApiToken | undefined> {
  const [row] = await tx
    .update(apiTokens)
    .set({ revokedAt: input.now, revokedByUserId: input.userId, revokeReason: input.reason })
    .where(
      and(
        eq(apiTokens.organizationId, input.organizationId),
        eq(apiTokens.id, input.id),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning();
  return row;
}

/** Revokes every still-active token of an integration; returns the revoked tokens. */
export async function revokeIntegrationTokens(
  tx: Transaction,
  input: {
    organizationId: string;
    integrationId: string;
    userId: string;
    reason: string;
    now: Date;
  },
): Promise<ApiToken[]> {
  return tx
    .update(apiTokens)
    .set({ revokedAt: input.now, revokedByUserId: input.userId, revokeReason: input.reason })
    .where(
      and(
        eq(apiTokens.organizationId, input.organizationId),
        eq(apiTokens.integrationId, input.integrationId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning();
}

/** Records use at most once a minute, so authentication does not write on every request. */
export async function touchToken(
  tx: Transaction,
  input: { organizationId: string; id: string; ip: string | null; now: Date },
): Promise<void> {
  await tx
    .update(apiTokens)
    .set({ lastUsedAt: input.now, lastUsedIp: input.ip })
    .where(
      and(
        eq(apiTokens.organizationId, input.organizationId),
        eq(apiTokens.id, input.id),
        sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} < ${new Date(input.now.getTime() - 60_000)})`,
      ),
    );
}

/**
 * Resolves the public part of a credential to its token, organization and service principal
 * before any tenant context exists (security definer function; identifiers only).
 */
export async function resolveApiToken(
  tx: Transaction,
  publicId: string,
): Promise<{ tokenId: string; organizationId: string; serviceUserId: string } | undefined> {
  const result = await tx.execute<{
    token_id: string;
    organization_id: string;
    service_user_id: string;
  }>(sql`SELECT * FROM app_resolve_api_token(${publicId})`);
  const row = result.rows[0];
  return row
    ? {
        tokenId: row.token_id,
        organizationId: row.organization_id,
        serviceUserId: row.service_user_id,
      }
    : undefined;
}
