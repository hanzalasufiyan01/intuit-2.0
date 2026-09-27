import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { normalizeEmail } from '../../shared/email.js';
import { users } from './schema.js';

export type User = typeof users.$inferSelect;

/** Public projection of a user; never includes the password hash. */
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  status: User['status'];
  emailVerified: boolean;
}

export function toUserProfile(user: User): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

export async function findUserByEmail(tx: Transaction, email: string): Promise<User | undefined> {
  const [row] = await tx
    .select()
    .from(users)
    .where(eq(users.emailNormalized, normalizeEmail(email)))
    .limit(1);
  return row;
}

export async function findUserById(tx: Transaction, id: string): Promise<User | undefined> {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function getUserProfiles(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, UserProfile>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(users)
    .where(inArray(users.id, [...ids]));
  return new Map(rows.map((row) => [row.id, toUserProfile(row)]));
}

/** Returns undefined when the email is already registered. */
export async function createUser(
  tx: Transaction,
  input: { email: string; displayName: string; passwordHash: string; now: Date },
): Promise<User | undefined> {
  const [row] = await tx
    .insert(users)
    .values({
      email: input.email.trim(),
      emailNormalized: normalizeEmail(input.email),
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
      passwordChangedAt: input.now,
    })
    .onConflictDoNothing({ target: users.emailNormalized })
    .returning();
  return row;
}

export async function updateUserPassword(
  tx: Transaction,
  userId: string,
  passwordHash: string,
  now: Date,
): Promise<void> {
  await tx.update(users).set({ passwordHash, passwordChangedAt: now }).where(eq(users.id, userId));
}

/** Account disablement. Callers must also revoke the user's sessions. */
export async function setUserDisabled(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ status: 'disabled', disabledAt: now })
    .where(and(eq(users.id, userId), eq(users.status, 'active')))
    .returning({ id: users.id });
  return rows.length > 0;
}
