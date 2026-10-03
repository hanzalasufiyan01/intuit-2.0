-- 0034_opening_balance_ap_guard — Phase 4, ADR 0004 P4-36.
--
-- The S8-07 opening-line guard (0017) also rejects ACCOUNTS_PAYABLE accounts, whether or not the
-- account is (yet) the Purchases AP control account: payables are opened through opening bills and
-- opening vendor credits in Purchases, never through generic opening balances, so the AP subledger
-- stays in balance with its control account. The application rule (openingLineIssues) is the
-- primary check at draft save, import, preview, submit and post; this trigger is the database
-- backstop on every opening line written. Everything else in the guard is unchanged: an explicit
-- classification is required, and receivable and control accounts stay rejected. Existing rows
-- are not touched (P4-36: existing posted AP opening balances are handled through guidance, never
-- automatic conversion).

CREATE OR REPLACE FUNCTION accounting_guard_opening_balance_line_account() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_account record;
BEGIN
  SELECT subtype, is_control_account INTO v_account
    FROM accounting_accounts
   WHERE id = NEW.account_id AND organization_id = NEW.organization_id;
  IF v_account.subtype IS NULL THEN
    RAISE EXCEPTION 'Opening balances need an explicitly classified account (account %).', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_account.subtype = 'ACCOUNTS_RECEIVABLE' OR v_account.is_control_account THEN
    RAISE EXCEPTION 'Receivable and control accounts cannot take opening balances (account %).', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_account.subtype = 'ACCOUNTS_PAYABLE' THEN
    RAISE EXCEPTION 'Payable accounts cannot take opening balances; use opening bills in Purchases (account %).', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
