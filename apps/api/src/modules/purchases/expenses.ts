import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import { purchasesExpenseLines, purchasesExpenses, type ExpenseStatus } from './expense-schema.js';

/** Direct expense data access (ADR 0004 P4-44). Rules live in the application service. */

export type Expense = typeof purchasesExpenses.$inferSelect;
export type ExpenseLine = typeof purchasesExpenseLines.$inferSelect;
export type NewExpense = typeof purchasesExpenses.$inferInsert;
export type ExpenseLineValues = Omit<
  typeof purchasesExpenseLines.$inferInsert,
  'id' | 'organizationId' | 'expenseId'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchasesExpenses.organizationId, organizationId), eq(purchasesExpenses.id, id));

export async function getExpense(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Expense | undefined> {
  const query = tx.select().from(purchasesExpenses).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getExpenseLines(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Promise<ExpenseLine[]> {
  return tx
    .select()
    .from(purchasesExpenseLines)
    .where(
      and(
        eq(purchasesExpenseLines.organizationId, organizationId),
        eq(purchasesExpenseLines.expenseId, expenseId),
      ),
    )
    .orderBy(asc(purchasesExpenseLines.lineNo));
}

export async function insertExpense(tx: Transaction, values: NewExpense): Promise<Expense> {
  const [row] = await tx.insert(purchasesExpenses).values(values).returning();
  return row!;
}

/**
 * Updates an expense when it is still in `from` (and at `version`, when given), bumping the
 * version. Returns undefined when someone else changed it first.
 */
export async function updateExpense(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: ExpenseStatus | readonly ExpenseStatus[];
    version?: number | undefined;
    set: Partial<NewExpense>;
  },
): Promise<Expense | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(purchasesExpenses)
    .set({ ...input.set, version: sql`${purchasesExpenses.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(purchasesExpenses.status, from),
        input.version === undefined ? undefined : eq(purchasesExpenses.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceExpenseLines(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
  lines: readonly ExpenseLineValues[],
): Promise<ExpenseLine[]> {
  await tx
    .delete(purchasesExpenseLines)
    .where(
      and(
        eq(purchasesExpenseLines.organizationId, organizationId),
        eq(purchasesExpenseLines.expenseId, expenseId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(purchasesExpenseLines)
    .values(lines.map((l) => ({ ...l, organizationId, expenseId })))
    .returning();
}

export async function deleteExpense(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(purchasesExpenses)
    .where(and(scoped(organizationId, id), eq(purchasesExpenses.status, 'DRAFT')))
    .returning({ id: purchasesExpenses.id });
  return row !== undefined;
}

export interface ExpenseListQuery {
  organizationId: string;
  statuses: readonly ExpenseStatus[] | null;
  vendorId: string | null;
  search: string | null;
  /** Also match these vendors (a name search through the vendors module). */
  vendorIdsIn?: SQL | undefined;
  from: string | null;
  to: string | null;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (expense_date DESC, id DESC). */
export async function listExpenses(tx: Transaction, query: ExpenseListQuery) {
  const t = purchasesExpenses;
  const conditions: (SQL | undefined)[] = [eq(t.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(t.status, [...query.statuses]));
  if (query.vendorId) conditions.push(eq(t.vendorId, query.vendorId));
  if (query.from) conditions.push(sql`${t.expenseDate} >= ${query.from}`);
  if (query.to) conditions.push(sql`${t.expenseDate} <= ${query.to}`);
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(t.number, pattern),
        ilike(t.vendorReference, pattern),
        query.vendorIdsIn ? sql`${t.vendorId} IN (${query.vendorIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${t.expenseDate}, ${t.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.expenseDate), desc(t.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

export async function expenseNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: purchasesExpenses.id })
    .from(purchasesExpenses)
    .where(
      and(
        eq(purchasesExpenses.organizationId, organizationId),
        eq(purchasesExpenses.number, number),
      ),
    )
    .limit(1);
  return row !== undefined;
}
