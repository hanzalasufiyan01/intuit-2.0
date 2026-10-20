/**
 * Expense policies (migration 0092; master specification section 13). Organization-defined rules,
 * evaluated when an expense is posted. Nothing is built in: every amount is the organization's.
 */
import { sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import type { Transaction } from '../../database/client.js';

export type PolicyRuleType = 'max_amount' | 'receipt_required_above';
export type PolicyAction = 'warn' | 'block';

export type ExpensePolicy = {
  id: string;
  name: string;
  ruleType: PolicyRuleType;
  amount: string;
  accountId: string | null;
  action: PolicyAction;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
};

const COLUMNS = sql`id, name, rule_type AS "ruleType", amount::text AS amount, account_id AS "accountId",
  action, status, version`;

export async function listExpensePolicies(tx: Transaction, organizationId: string) {
  const result = await tx.execute<ExpensePolicy>(sql`
    SELECT ${COLUMNS} FROM expense_policies WHERE organization_id = ${organizationId}
     ORDER BY status, lower(name), id`);
  return result.rows;
}

export async function getExpensePolicy(tx: Transaction, organizationId: string, id: string) {
  const result = await tx.execute<ExpensePolicy>(sql`
    SELECT ${COLUMNS} FROM expense_policies WHERE organization_id = ${organizationId} AND id = ${id}`);
  return result.rows[0];
}

export async function insertExpensePolicy(
  tx: Transaction,
  input: {
    organizationId: string;
    name: string;
    ruleType: PolicyRuleType;
    amount: string;
    accountId: string | null;
    action: PolicyAction;
    userId: string;
    at: Date;
  },
) {
  const at = input.at.toISOString();
  const result = await tx.execute<ExpensePolicy>(sql`
    INSERT INTO expense_policies (organization_id, name, rule_type, amount, account_id, action,
                                  created_by_user_id, created_at, updated_by_user_id, updated_at)
    VALUES (${input.organizationId}, ${input.name}, ${input.ruleType}, ${input.amount}, ${input.accountId},
            ${input.action}, ${input.userId}, ${at}::timestamptz, ${input.userId}, ${at}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING ${COLUMNS}`);
  return result.rows[0];
}

export async function updateExpensePolicy(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: { name?: string; amount?: string; action?: PolicyAction; status?: 'ACTIVE' | 'ARCHIVED' };
    userId: string;
    at: Date;
  },
) {
  const s = input.set;
  const result = await tx.execute<ExpensePolicy>(sql`
    UPDATE expense_policies SET
      name = COALESCE(${s.name ?? null}, name),
      amount = COALESCE(${s.amount ?? null}::numeric, amount),
      action = COALESCE(${s.action ?? null}, action),
      status = COALESCE(${s.status ?? null}, status),
      version = version + 1, updated_by_user_id = ${input.userId}, updated_at = ${input.at.toISOString()}::timestamptz
     WHERE organization_id = ${input.organizationId} AND id = ${input.id} AND version = ${input.version}
 RETURNING ${COLUMNS}`);
  return result.rows[0];
}

/** Files attached to an expense (or claim) that are still available. */
export async function countAttachments(
  tx: Transaction,
  organizationId: string,
  linkType: 'expense' | 'expense_claim',
  linkId: string,
) {
  const result = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM file_links l JOIN files f ON f.id = l.file_id AND f.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.link_type = ${linkType} AND l.link_id = ${linkId}
       AND f.status = 'available'`);
  return result.rows[0]?.n ?? 0;
}

export interface PolicyViolation {
  policyId: string;
  name: string;
  ruleType: PolicyRuleType;
  action: PolicyAction;
  message: string;
}

/**
 * Pure evaluation: which active rules the expense breaks. `total` and `byAccount` are base-currency
 * amounts; `attachments` is the number of attached files.
 */
export function evaluateExpensePolicies(
  policies: readonly ExpensePolicy[],
  input: { total: Decimal; byAccount: ReadonlyMap<string, Decimal>; attachments: number },
): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const p of policies) {
    if (p.status !== 'ACTIVE') continue;
    const limit = new Decimal(p.amount);
    if (p.ruleType === 'max_amount') {
      const amount = p.accountId
        ? (input.byAccount.get(p.accountId) ?? new Decimal(0))
        : input.total;
      if (amount.gt(limit)) {
        out.push({
          policyId: p.id,
          name: p.name,
          ruleType: p.ruleType,
          action: p.action,
          message: `${p.name}: ${amount.toFixed()} is above the limit of ${limit.toFixed()}.`,
        });
      }
    } else if (input.total.gt(limit) && input.attachments < 1) {
      out.push({
        policyId: p.id,
        name: p.name,
        ruleType: p.ruleType,
        action: p.action,
        message: `${p.name}: a receipt must be attached when the total is above ${limit.toFixed()}.`,
      });
    }
  }
  return out;
}
