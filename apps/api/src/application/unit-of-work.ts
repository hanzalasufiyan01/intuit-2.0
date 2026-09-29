import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';

/**
 * Database request context. Applied with transaction-local `set_config`, it drives the
 * PostgreSQL Row-Level Security policies (defence-in-depth). It never replaces the
 * application authorization checks, which always run first.
 */
export interface DbContext {
  userId?: string | null;
  organizationId?: string | null;
}

export async function setDbContext(tx: Transaction, context: DbContext): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${context.userId ?? ''}, true),
               set_config('app.organization_id', ${context.organizationId ?? ''}, true)`,
  );
}

/**
 * Runs `work` in one transaction with the given RLS context. `readOnlySnapshot` runs it as a
 * REPEATABLE READ, READ ONLY transaction so every query sees the same snapshot (reports).
 */
export async function inTransaction<T>(
  db: Database,
  context: DbContext,
  work: (tx: Transaction) => Promise<T>,
  options: { readOnlySnapshot?: boolean } = {},
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await setDbContext(tx, context);
      return work(tx);
    },
    options.readOnlySnapshot
      ? { isolationLevel: 'repeatable read', accessMode: 'read only' }
      : undefined,
  );
}
