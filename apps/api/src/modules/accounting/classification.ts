import { accountSubtypesByType, type AccountSubtype, type AccountType } from './schema.js';

/**
 * Account classification rules (Decisions 2, 53, 54). Pure functions; the database enforces
 * the same rules with CHECK constraints.
 */

/** Monetary by definition (Decision 53). */
export const ALWAYS_MONETARY_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  'BANK',
  'CASH',
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'CREDIT_CARD',
]);

/**
 * Monetary only when the organization marks the account explicitly (Decision 53; the S9 amendment
 * N9 adds the other current and other asset subtypes). Never inferred from names or usage.
 */
export const OPTIONALLY_MONETARY_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  'OTHER_CURRENT_ASSET',
  'OTHER_ASSET',
  'OTHER_CURRENT_LIABILITY',
  'LONG_TERM_LIABILITY',
]);

export function subtypeMatchesType(subtype: AccountSubtype, type: AccountType): boolean {
  return (accountSubtypesByType[type] as readonly string[]).includes(subtype);
}

/** Bank/cash designation is the Bank or Cash subtype (Decision 53). */
export function isBankOrCash(subtype: AccountSubtype | null): boolean {
  return subtype === 'BANK' || subtype === 'CASH';
}

/**
 * The monetary flag for a subtype. `requested` is the caller's explicit choice, if any.
 * Always-monetary subtypes are monetary, optional subtypes follow the explicit choice
 * (default: not monetary), and every other subtype (or no subtype) is non-monetary.
 */
export function resolveMonetary(
  subtype: AccountSubtype | null,
  requested: boolean | undefined,
): { ok: true; value: boolean } | { ok: false; message: string } {
  if (subtype && ALWAYS_MONETARY_SUBTYPES.has(subtype)) {
    if (requested === false) {
      return { ok: false, message: 'Accounts of this subtype are always monetary.' };
    }
    return { ok: true, value: true };
  }
  if (subtype && OPTIONALLY_MONETARY_SUBTYPES.has(subtype)) {
    return { ok: true, value: requested ?? false };
  }
  if (requested === true) {
    return {
      ok: false,
      message:
        'Only Bank, Cash, Accounts Receivable, Accounts Payable, Credit Card and explicitly marked other asset, current liability or long-term liability accounts are monetary.',
    };
  }
  return { ok: true, value: false };
}
