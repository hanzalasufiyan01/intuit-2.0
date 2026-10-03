import type { Decimal } from 'decimal.js';
import { decimal } from '../../domain/money.js';

/**
 * Input tax on purchases (ADR 0004 P4-11, P4-12; brief §13). Pure rules, used by the purchase
 * documents when they post; output (Sales) tax is unaffected and keeps the code's
 * `tax_account_id`.
 *
 * - P4-11: a tax code used on a purchase line must have an input tax account, otherwise posting
 *   is blocked with guidance.
 * - P4-12: each purchase line carries `tax_recoverable`. Recoverable tax posts to the code's input
 *   tax account; non-recoverable tax is added to the line's own account (capitalized into the
 *   cost). The flag defaults from the organization's GST registration on the document date (not
 *   registered: not recoverable), then the item's default, then the vendor's default, and
 *   otherwise recoverable; a user may override it per line (with `bills.create`, Bills stage).
 */

/** Why a tax code cannot be used on a purchase line, or null when it can (P4-11). */
export function purchaseTaxCodeProblem(
  code: { code: string; status: string; inputTaxAccountId: string | null },
  inputAccount: {
    status: string;
    isLeaf: boolean;
    accountType: string;
    isControlAccount: boolean;
  } | null,
): string | null {
  if (code.status !== 'ACTIVE') return `${code.code} is archived.`;
  if (!code.inputTaxAccountId) {
    return `${code.code} has no input tax account. Set one under Tax codes before using it on purchases.`;
  }
  if (!inputAccount) return `The input tax account of ${code.code} was not found.`;
  if (inputAccount.status !== 'ACTIVE') {
    return `The input tax account of ${code.code} is archived. Choose an active account under Tax codes.`;
  }
  if (
    !inputAccount.isLeaf ||
    inputAccount.accountType !== 'ASSET' ||
    inputAccount.isControlAccount
  ) {
    return `The input tax account of ${code.code} is no longer a usable asset account. Review it under Tax codes.`;
  }
  return null;
}

/** Whether the organization is GST-registered on a date (registration date inclusive). */
export function gstRegisteredOn(
  organization: { gstRegistered: boolean; gstRegisteredFrom: string | null },
  documentDate: string,
): boolean {
  if (!organization.gstRegistered) return false;
  return organization.gstRegisteredFrom === null || organization.gstRegisteredFrom <= documentDate;
}

/**
 * The default `tax_recoverable` of a purchase line (P4-12, decided 2026-10-01): not registered on
 * the document date → false; otherwise the item's default, then the vendor's default (NULL means
 * "no default"), otherwise true. The user may then override it.
 */
export function defaultTaxRecoverable(input: {
  organization: { gstRegistered: boolean; gstRegisteredFrom: string | null };
  documentDate: string;
  itemDefault: boolean | null;
  vendorDefault: boolean | null;
}): boolean {
  if (!gstRegisteredOn(input.organization, input.documentDate)) return false;
  return input.itemDefault ?? input.vendorDefault ?? true;
}

/** A line's tax split by recoverability: all of it is one or the other (P4-12). */
export function splitLineTax(tax: Decimal, recoverable: boolean) {
  return recoverable
    ? { recoverableTax: tax, nonRecoverableTax: decimal(0) }
    : { recoverableTax: decimal(0), nonRecoverableTax: tax };
}

/**
 * What a posted purchase line freezes about its tax (Decision 15, brief §13): the code, the rate
 * version and percentage used, the recoverability, the amounts and the input account resolved at
 * posting. Persisted by the purchase documents that post (Bills stage).
 */
export interface PurchaseLineTaxSnapshot {
  taxCodeId: string | null;
  taxRateId: string | null;
  taxRate: string | null;
  taxRecoverable: boolean;
  taxAmount: string;
  recoverableTax: string;
  nonRecoverableTax: string;
  inputTaxAccountId: string | null;
}
