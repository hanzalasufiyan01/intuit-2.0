import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { organizationSecurityPolicies } from './schema.js';

/** Organization MFA policy (S7-29, S7-36). Version 0 means "never saved" (defaults apply). */
export interface SecurityPolicy {
  requireMfaForAllMembers: boolean;
  allowTrustedDevices: boolean;
  version: number;
  updatedByUserId: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  requireMfaForAllMembers: false,
  allowTrustedDevices: true,
  version: 0,
  updatedByUserId: null,
  updatedAt: null,
};

/** Reads the policy of the context organization (tenant RLS applies). */
export async function getSecurityPolicy(
  tx: Transaction,
  organizationId: string,
): Promise<SecurityPolicy> {
  const [row] = await tx
    .select()
    .from(organizationSecurityPolicies)
    .where(eq(organizationSecurityPolicies.organizationId, organizationId))
    .limit(1);
  if (!row) return DEFAULT_SECURITY_POLICY;
  return {
    requireMfaForAllMembers: row.requireMfaForAllMembers,
    allowTrustedDevices: row.allowTrustedDevices,
    version: row.version,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Saves the policy if `expectedVersion` is current (optimistic concurrency). Returns the new
 * policy, or undefined on a version conflict.
 */
export async function saveSecurityPolicy(
  tx: Transaction,
  input: {
    organizationId: string;
    expectedVersion: number;
    requireMfaForAllMembers: boolean;
    allowTrustedDevices: boolean;
    userId: string;
    now: Date;
  },
): Promise<SecurityPolicy | undefined> {
  const values = {
    requireMfaForAllMembers: input.requireMfaForAllMembers,
    allowTrustedDevices: input.allowTrustedDevices,
    updatedByUserId: input.userId,
    updatedAt: input.now,
  };
  const rows =
    input.expectedVersion === 0
      ? await tx
          .insert(organizationSecurityPolicies)
          .values({ organizationId: input.organizationId, version: 1, ...values })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(organizationSecurityPolicies)
          .set({ ...values, version: sql`${organizationSecurityPolicies.version} + 1` })
          .where(
            and(
              eq(organizationSecurityPolicies.organizationId, input.organizationId),
              eq(organizationSecurityPolicies.version, input.expectedVersion),
            ),
          )
          .returning();
  const [row] = rows;
  if (!row) return undefined;
  return {
    requireMfaForAllMembers: row.requireMfaForAllMembers,
    allowTrustedDevices: row.allowTrustedDevices,
    version: row.version,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/** Enrollment status of every member of the context organization (definer function, S7-39). */
export async function listMemberMfaEnrollment(tx: Transaction): Promise<Map<string, boolean>> {
  const result = await tx.execute<{ membership_id: string; enrolled: boolean }>(
    sql`SELECT membership_id, enrolled FROM app_member_mfa_enrollment()`,
  );
  return new Map(result.rows.map((r) => [r.membership_id, r.enrolled]));
}
