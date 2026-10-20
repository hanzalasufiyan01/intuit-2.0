import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { ownershipTransfers } from './schema.js';

/** Data access of the ownership-transfer workflow (ADR 0012). Rows are never deleted. */

export type OwnershipTransfer = typeof ownershipTransfers.$inferSelect;

export const OPEN_TRANSFER_STATUSES = ['initiated', 'verified', 'accepted'] as const;

export async function insertOwnershipTransfer(
  tx: Transaction,
  input: {
    organizationId: string;
    fromMembershipId: string;
    toMembershipId: string;
    replacementRoleId: string;
    initiatedByUserId: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<OwnershipTransfer | undefined> {
  const [row] = await tx
    .insert(ownershipTransfers)
    .values({
      organizationId: input.organizationId,
      fromMembershipId: input.fromMembershipId,
      toMembershipId: input.toMembershipId,
      replacementRoleId: input.replacementRoleId,
      initiatedByUserId: input.initiatedByUserId,
      status: 'initiated',
      initiatedAt: input.now,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function getOwnershipTransfer(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<OwnershipTransfer | undefined> {
  const query = tx
    .select()
    .from(ownershipTransfers)
    .where(
      and(eq(ownershipTransfers.organizationId, organizationId), eq(ownershipTransfers.id, id)),
    )
    .limit(1);
  const [row] = await (options.forUpdate ? query.for('update') : query);
  return row;
}

export async function findOpenOwnershipTransfer(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<OwnershipTransfer | undefined> {
  const query = tx
    .select()
    .from(ownershipTransfers)
    .where(
      and(
        eq(ownershipTransfers.organizationId, organizationId),
        inArray(ownershipTransfers.status, [...OPEN_TRANSFER_STATUSES]),
      ),
    )
    .limit(1);
  const [row] = await (options.forUpdate ? query.for('update') : query);
  return row;
}

export async function listOwnershipTransfers(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<OwnershipTransfer[]> {
  return tx
    .select()
    .from(ownershipTransfers)
    .where(eq(ownershipTransfers.organizationId, organizationId))
    .orderBy(desc(ownershipTransfers.initiatedAt), desc(ownershipTransfers.id))
    .limit(limit);
}

export type TransferChanges = Partial<
  Pick<
    OwnershipTransfer,
    | 'status'
    | 'verifiedAt'
    | 'acceptedAt'
    | 'acceptedByUserId'
    | 'completedAt'
    | 'cancelledAt'
    | 'cancelledByUserId'
    | 'cancelReason'
    | 'expiredAt'
  >
>;

export async function updateOwnershipTransfer(
  tx: Transaction,
  organizationId: string,
  id: string,
  changes: TransferChanges,
): Promise<OwnershipTransfer | undefined> {
  const [row] = await tx
    .update(ownershipTransfers)
    .set(changes)
    .where(
      and(eq(ownershipTransfers.organizationId, organizationId), eq(ownershipTransfers.id, id)),
    )
    .returning();
  return row;
}
