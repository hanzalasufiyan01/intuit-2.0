import { and, asc, eq } from 'drizzle-orm';
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/**
 * Branch-scoped access (migration 0084, FP-24). A branch is a dimension value. A restricted member
 * sees only invoices and bills tagged with one of their branches (enforced by row-level security,
 * not by the services) and keeps only the permissions below.
 */

export const membershipBranchScopes = pgTable('membership_branch_scopes', {
  organizationId: uuid('organization_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  dimensionValueId: uuid('dimension_value_id').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});

/**
 * The only permissions a branch-restricted member keeps. Everything here is either master data or
 * an operation on invoices and bills, whose rows the database narrows to the member's branches.
 * Reports, the ledger, payments, receipts, credit notes, inventory and payroll are NOT here: they
 * do not honour a branch, so a restricted member cannot use them.
 */
export const BRANCH_SCOPED_PERMISSIONS: ReadonlySet<string> = new Set([
  'organization.read',
  'accounting.dimensions.view',
  'customers.view',
  'vendors.view',
  'invoices.view',
  'invoices.create',
  'invoices.edit_draft',
  'invoices.delete_draft',
  'invoices.issue',
  'bills.view',
  'bills.create',
  'bills.edit_draft',
  'bills.delete_draft',
  'bills.post',
]);

export async function branchScopeOf(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: membershipBranchScopes.dimensionValueId })
    .from(membershipBranchScopes)
    .where(
      and(
        eq(membershipBranchScopes.organizationId, organizationId),
        eq(membershipBranchScopes.membershipId, membershipId),
      ),
    )
    .orderBy(asc(membershipBranchScopes.dimensionValueId));
  return rows.map((r) => r.id);
}

export async function listBranchScopes(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(membershipBranchScopes)
    .where(eq(membershipBranchScopes.organizationId, organizationId))
    .orderBy(
      asc(membershipBranchScopes.membershipId),
      asc(membershipBranchScopes.dimensionValueId),
    );
}

export async function replaceBranchScope(
  tx: Transaction,
  input: {
    organizationId: string;
    membershipId: string;
    dimensionValueIds: readonly string[];
    userId: string;
    at: Date;
  },
) {
  await tx
    .delete(membershipBranchScopes)
    .where(
      and(
        eq(membershipBranchScopes.organizationId, input.organizationId),
        eq(membershipBranchScopes.membershipId, input.membershipId),
      ),
    );
  if (input.dimensionValueIds.length) {
    await tx.insert(membershipBranchScopes).values(
      input.dimensionValueIds.map((dimensionValueId) => ({
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        dimensionValueId,
        createdByUserId: input.userId,
        createdAt: input.at,
      })),
    );
  }
}

/**
 * What a member may do right now: an owner is never restricted; a member with branches keeps only
 * the allow-listed permissions; everyone else is unchanged. `branchScope` is null when unrestricted.
 */
export async function scopeAccess(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
  access: { isOwner: boolean; permissions: ReadonlySet<string> },
): Promise<{ permissions: ReadonlySet<string>; branchScope: string[] | null }> {
  if (access.isOwner) return { permissions: access.permissions, branchScope: null };
  const scope = await branchScopeOf(tx, organizationId, membershipId);
  if (!scope.length) return { permissions: access.permissions, branchScope: null };
  return {
    permissions: new Set([...access.permissions].filter((p) => BRANCH_SCOPED_PERMISSIONS.has(p))),
    branchScope: scope,
  };
}
