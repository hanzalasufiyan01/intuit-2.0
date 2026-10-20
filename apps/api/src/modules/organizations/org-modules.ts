import { and, eq } from 'drizzle-orm';
import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/** Optional product modules an organization switches on (migration 0065, FP-24). */
export const optionalModules = ['payroll', 'projects', 'clinic'] as const;
export type OptionalModule = (typeof optionalModules)[number];

export const organizationModules = pgTable('organization_modules', {
  organizationId: uuid('organization_id').notNull(),
  moduleKey: text('module_key', { enum: optionalModules }).notNull(),
  enabled: boolean('enabled').notNull(),
  changedByUserId: uuid('changed_by_user_id'),
  changedAt: timestamptz('changed_at').notNull(),
});

export async function listModuleStates(
  tx: Transaction,
  organizationId: string,
): Promise<Record<OptionalModule, boolean>> {
  const rows = await tx
    .select()
    .from(organizationModules)
    .where(eq(organizationModules.organizationId, organizationId));
  const state = Object.fromEntries(optionalModules.map((m) => [m, false])) as Record<
    OptionalModule,
    boolean
  >;
  for (const row of rows) state[row.moduleKey] = row.enabled;
  return state;
}

export async function isModuleEnabled(
  tx: Transaction,
  organizationId: string,
  moduleKey: OptionalModule,
): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: organizationModules.enabled })
    .from(organizationModules)
    .where(
      and(
        eq(organizationModules.organizationId, organizationId),
        eq(organizationModules.moduleKey, moduleKey),
      ),
    );
  return row?.enabled === true;
}

export async function setModuleEnabled(
  tx: Transaction,
  input: {
    organizationId: string;
    moduleKey: OptionalModule;
    enabled: boolean;
    userId: string;
    at: Date;
  },
): Promise<void> {
  await tx
    .insert(organizationModules)
    .values({
      organizationId: input.organizationId,
      moduleKey: input.moduleKey,
      enabled: input.enabled,
      changedByUserId: input.userId,
      changedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [organizationModules.organizationId, organizationModules.moduleKey],
      set: { enabled: input.enabled, changedByUserId: input.userId, changedAt: input.at },
    });
}
