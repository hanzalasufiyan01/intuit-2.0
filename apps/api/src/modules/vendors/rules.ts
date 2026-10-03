/**
 * Accounts a purchase line may post to (ADR 0004 P4-19, amended and clarified): active leaf
 * accounts classified as operating expense, other expense, cost of sales, fixed asset, other asset
 * or other current asset (which covers prepaid expenses). Control, bank/cash, receivable, payable,
 * card, equity, revenue, unclassified and designated system accounts are refused. Classification
 * is never inferred. Pure; used for a vendor's default expense account and later by bill lines.
 */
export const PURCHASE_ACCOUNT_SUBTYPES = [
  'OPERATING_EXPENSE',
  'OTHER_EXPENSE',
  'COST_OF_SALES',
  'FIXED_ASSET',
  'OTHER_ASSET',
  'OTHER_CURRENT_ASSET',
] as const;

export function purchaseAccountProblem(account: {
  status: string;
  isLeaf: boolean;
  subtype: string | null;
  isControlAccount: boolean;
  designated: boolean;
}): string | null {
  if (account.status !== 'ACTIVE') return 'The account is archived.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) return 'A control account cannot be used on purchases.';
  if (account.designated) return 'A designated system account cannot be used on purchases.';
  if (account.subtype === null) {
    return 'The account is unclassified; classify it before using it on purchases.';
  }
  if (!(PURCHASE_ACCOUNT_SUBTYPES as readonly string[]).includes(account.subtype)) {
    return 'Choose an expense, cost of sales or asset account (not bank, cash, receivable, payable, card, equity or revenue).';
  }
  return null;
}
