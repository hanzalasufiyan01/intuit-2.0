import { and, eq } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { AccountType } from './schema.js';
import { accountingDesignations, designations, type Designation } from './schema.js';

export type DesignationRow = typeof accountingDesignations.$inferSelect;
export { designations, type Designation };

/**
 * Account nature each designation requires: Retained Earnings and Opening Balance Equity are
 * equity accounts; FX gain/loss and rounding differences are income-statement accounts.
 */
export const designationAccountTypes: Record<Designation, readonly AccountType[]> = {
  RETAINED_EARNINGS: ['EQUITY'],
  OPENING_BALANCE_EQUITY: ['EQUITY'],
  REALIZED_FX_GAIN_LOSS: ['REVENUE', 'EXPENSE'],
  UNREALIZED_FX_GAIN_LOSS: ['REVENUE', 'EXPENSE'],
  ROUNDING_DIFFERENCE: ['REVENUE', 'EXPENSE'],
};

export async function listDesignations(
  tx: Transaction,
  organizationId: string,
): Promise<DesignationRow[]> {
  return tx
    .select()
    .from(accountingDesignations)
    .where(eq(accountingDesignations.organizationId, organizationId));
}

export async function getDesignatedAccountId(
  tx: Transaction,
  organizationId: string,
  designation: Designation,
): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: accountingDesignations.accountId })
    .from(accountingDesignations)
    .where(
      and(
        eq(accountingDesignations.organizationId, organizationId),
        eq(accountingDesignations.designation, designation),
      ),
    )
    .limit(1);
  return row?.accountId ?? null;
}

/** Designations held by an account. */
export async function designationsOfAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<Designation[]> {
  const rows = await tx
    .select({ designation: accountingDesignations.designation })
    .from(accountingDesignations)
    .where(
      and(
        eq(accountingDesignations.organizationId, organizationId),
        eq(accountingDesignations.accountId, accountId),
      ),
    );
  return rows.map((r) => r.designation);
}

export async function setDesignation(
  tx: Transaction,
  input: {
    organizationId: string;
    designation: Designation;
    accountId: string | null;
    userId: string;
    now: Date;
  },
): Promise<void> {
  if (input.accountId === null) {
    await tx
      .delete(accountingDesignations)
      .where(
        and(
          eq(accountingDesignations.organizationId, input.organizationId),
          eq(accountingDesignations.designation, input.designation),
        ),
      );
    return;
  }
  await tx
    .insert(accountingDesignations)
    .values({
      organizationId: input.organizationId,
      designation: input.designation,
      accountId: input.accountId,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [accountingDesignations.organizationId, accountingDesignations.designation],
      set: { accountId: input.accountId, updatedByUserId: input.userId, updatedAt: input.now },
    });
}
