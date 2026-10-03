-- 0032_input_tax — Phase 4 input-tax stage (ADR 0004 P4-11, P4-12, P4-13).
--
-- * tax_codes.input_tax_account_id (P4-11): the account recoverable purchase tax posts to. Optional
--   on the code; a code used on a purchase document must have one (checked when the document
--   posts). Output tax keeps tax_account_id, unchanged. The account must be an asset (an
--   application rule, as for the output account). Existing codes stay NULL: existing
--   organizations map it explicitly; nothing is inferred (P4-13, Decision 54).
-- * Recoverability defaults (P4-12, decided 2026-10-01): catalog items and vendors gain an
--   optional default. NULL means "no default" and the next step of the defaulting chain applies.
--   The per-line tax_recoverable flag itself belongs to the purchase documents (Bills stage).
-- Everything is additive; no existing row changes.

ALTER TABLE tax_codes
  ADD COLUMN input_tax_account_id uuid,
  ADD CONSTRAINT tax_codes_input_account_fkey FOREIGN KEY (input_tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id);

ALTER TABLE sales_items
  ADD COLUMN purchase_tax_recoverable boolean;

ALTER TABLE vendors
  ADD COLUMN default_tax_recoverable boolean;
