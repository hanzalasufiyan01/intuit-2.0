import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { generateSecureToken, hashToken } from '../../infrastructure/security/tokens.js';
import { normalizeEmail } from '../../shared/email.js';
import { invitations, type InvitationStatus } from './schema.js';

export type Invitation = typeof invitations.$inferSelect;

/** Pending invitations past their expiry are reported as expired. */
export function effectiveInvitationStatus(invitation: Invitation, now: Date): InvitationStatus {
  if (invitation.status === 'pending' && invitation.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return invitation.status;
}

export interface IssuedInvitation {
  invitation: Invitation;
  /** Raw token for the invitation link. Returned once, never stored. */
  token: string;
}

/** Returns undefined if a live pending invitation already exists for this email. */
export async function createInvitation(
  tx: Transaction,
  input: {
    organizationId: string;
    email: string;
    roleId: string;
    invitedByUserId: string;
    now: Date;
    expiryMs: number;
  },
): Promise<IssuedInvitation | undefined> {
  const emailNormalized = normalizeEmail(input.email);
  // A lapsed pending invitation must not block a fresh one.
  await tx
    .update(invitations)
    .set({ status: 'expired' })
    .where(
      and(
        eq(invitations.organizationId, input.organizationId),
        eq(invitations.emailNormalized, emailNormalized),
        eq(invitations.status, 'pending'),
        lte(invitations.expiresAt, input.now),
      ),
    );

  const token = generateSecureToken();
  const [invitation] = await tx
    .insert(invitations)
    .values({
      organizationId: input.organizationId,
      email: input.email.trim(),
      emailNormalized,
      roleId: input.roleId,
      invitedByUserId: input.invitedByUserId,
      tokenHash: hashToken(token),
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.expiryMs),
    })
    .onConflictDoNothing({
      target: [invitations.organizationId, invitations.emailNormalized],
      where: sql`status = 'pending'`,
    })
    .returning();
  return invitation ? { invitation, token } : undefined;
}

export async function listInvitations(
  tx: Transaction,
  organizationId: string,
): Promise<Invitation[]> {
  return tx
    .select()
    .from(invitations)
    .where(eq(invitations.organizationId, organizationId))
    .orderBy(desc(invitations.createdAt))
    .limit(200);
}

export async function findInvitationById(
  tx: Transaction,
  organizationId: string,
  invitationId: string,
): Promise<Invitation | undefined> {
  const [row] = await tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, organizationId), eq(invitations.id, invitationId)))
    .limit(1);
  return row;
}

/**
 * Maps an invitation token to its organization before any organization context exists,
 * via a narrow SECURITY DEFINER function that returns identifiers only.
 */
export async function resolveInvitationToken(
  tx: Transaction,
  token: string,
): Promise<{ invitationId: string; organizationId: string } | undefined> {
  const result = await tx.execute<{ invitation_id: string; organization_id: string }>(
    sql`SELECT invitation_id, organization_id FROM app_resolve_invitation_token(${hashToken(token)})`,
  );
  const row = result.rows[0];
  return row ? { invitationId: row.invitation_id, organizationId: row.organization_id } : undefined;
}

export async function markInvitationAccepted(
  tx: Transaction,
  input: { organizationId: string; invitationId: string; userId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: input.now, acceptedByUserId: input.userId })
    .where(
      and(
        eq(invitations.organizationId, input.organizationId),
        eq(invitations.id, input.invitationId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning({ id: invitations.id });
  return rows.length > 0;
}

export async function revokeInvitation(
  tx: Transaction,
  input: { organizationId: string; invitationId: string; userId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(invitations)
    .set({ status: 'revoked', revokedAt: input.now, revokedByUserId: input.userId })
    .where(
      and(
        eq(invitations.organizationId, input.organizationId),
        eq(invitations.id, input.invitationId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning({ id: invitations.id });
  return rows.length > 0;
}
