-- 0042_opening_ap_documents — Phase 4B (opening AP): opening bills and opening vendor credits
-- (ADR 0004 P4-35, P4-36, P4-37; mirrors the Sales opening invoice, Phase 3B D5 / Decision 69).
--
-- An opening bill (kind 'opening') brings a vendor's open balance at conversion into the AP
-- subledger: dated on or before the S8 opening date, no tax and no expense, it posts
-- Dr Opening Balance Equity / Cr AP control through the same approval and Post path. An opening
-- vendor credit (kind 'opening', origin 'supplier_credit_note') is the reverse: Dr AP control /
-- Cr Opening Balance Equity. A foreign-currency opening document may carry an explicit base
-- carrying value (S8-06); otherwise the table rate applies. Nothing else about a bill or a vendor
-- credit changes: the lifecycle, numbering, void and the AP invariant are the same.
--
-- * The posted-document guards gain the carrying value as immutable; opening documents never carry
--   a manual rate or a supplier reference requirement, and an opening credit is never linked to a
--   bill.
-- * 'carrying' joins the exchange-rate sources: the base comes from the explicit carrying value
--   (the rate shown is implied).

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------

ALTER TABLE purchases_bills DROP CONSTRAINT purchases_bills_kind_check;
ALTER TABLE purchases_bills ADD CONSTRAINT purchases_bills_kind_check
  CHECK (kind IN ('standard', 'opening'));
ALTER TABLE purchases_bills ADD COLUMN opening_base_total numeric(28, 4)
  CHECK (opening_base_total IS NULL OR opening_base_total > 0);
ALTER TABLE purchases_bills ADD CONSTRAINT purchases_bills_opening_base_kind
  CHECK (opening_base_total IS NULL OR kind = 'opening');
ALTER TABLE purchases_bills ADD CONSTRAINT purchases_bills_opening_no_override
  CHECK (kind <> 'opening' OR rate_override IS NULL);
ALTER TABLE purchases_bills DROP CONSTRAINT purchases_bills_exchange_rate_source_check;
ALTER TABLE purchases_bills ADD CONSTRAINT purchases_bills_exchange_rate_source_check CHECK (
  exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual', 'carrying'));
-- The supplier's invoice number is required to post a standard bill (P4-17), not an opening one.
ALTER TABLE purchases_bills DROP CONSTRAINT purchases_bills_posted_consistency;
ALTER TABLE purchases_bills ADD CONSTRAINT purchases_bills_posted_consistency CHECK (
  (status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)
  AND (status NOT IN ('POSTED', 'VOID') OR (
    number IS NOT NULL AND (kind = 'opening' OR vendor_reference IS NOT NULL) AND journal_id IS NOT NULL
    AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL
    AND base_total IS NOT NULL AND amount_due IS NOT NULL AND base_due IS NOT NULL)));

-- The 0033 guard, with the carrying value immutable once posted.
CREATE OR REPLACE FUNCTION purchases_guard_bill() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft bills can be deleted (bill %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.kind, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.kind, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'bill % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'bill % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'POSTED'))
    OR (OLD.status = 'POSTED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'bill % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void bill % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'POSTED' THEN
    -- Posted: only the open balance changes, and an unpaid bill may be voided (P4-21).
    IF (NEW.vendor_id, NEW.number, NEW.vendor_reference, NEW.bill_date, NEW.due_date,
        NEW.payment_terms_days, NEW.currency_code, NEW.rate_override, NEW.rate_override_reason,
        NEW.exchange_rate, NEW.exchange_rate_source, NEW.table_rate, NEW.tax_treatment,
        NEW.discount_type, NEW.discount_value, NEW.memo, NEW.dimension_value_ids, NEW.subtotal,
        NEW.discount_total, NEW.tax_total, NEW.recoverable_tax_total, NEW.total, NEW.base_total,
        NEW.duplicate_confirmed_reason, NEW.approval_request_id, NEW.submitted_by_user_id,
        NEW.submitted_at, NEW.posted_by_user_id, NEW.posted_at, NEW.journal_id,
        NEW.accounting_event_id, NEW.opening_base_total)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.number, OLD.vendor_reference, OLD.bill_date, OLD.due_date,
        OLD.payment_terms_days, OLD.currency_code, OLD.rate_override, OLD.rate_override_reason,
        OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate, OLD.tax_treatment,
        OLD.discount_type, OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal,
        OLD.discount_total, OLD.tax_total, OLD.recoverable_tax_total, OLD.total, OLD.base_total,
        OLD.duplicate_confirmed_reason, OLD.approval_request_id, OLD.submitted_by_user_id,
        OLD.submitted_at, OLD.posted_by_user_id, OLD.posted_at, OLD.journal_id,
        OLD.accounting_event_id, OLD.opening_base_total) THEN
      RAISE EXCEPTION 'posted bill % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'VOID' AND (OLD.amount_due <> OLD.total OR OLD.base_due <> OLD.base_total) THEN
      RAISE EXCEPTION 'bill % has payments or credits applied and cannot be voided', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Vendor credits
-- ---------------------------------------------------------------------------

ALTER TABLE purchases_vendor_credits ADD COLUMN kind text NOT NULL DEFAULT 'standard'
  CHECK (kind IN ('standard', 'opening'));
ALTER TABLE purchases_vendor_credits ADD COLUMN opening_base_total numeric(28, 4)
  CHECK (opening_base_total IS NULL OR opening_base_total > 0);
ALTER TABLE purchases_vendor_credits ADD CONSTRAINT purchases_vendor_credits_opening_base_kind
  CHECK (opening_base_total IS NULL OR kind = 'opening');
-- An opening credit is a supplier credit at conversion: not a debit note, not linked to a bill,
-- and without a manual rate.
ALTER TABLE purchases_vendor_credits ADD CONSTRAINT purchases_vendor_credits_opening_shape
  CHECK (kind = 'standard' OR (origin = 'supplier_credit_note' AND bill_id IS NULL AND rate_override IS NULL));
ALTER TABLE purchases_vendor_credits DROP CONSTRAINT purchases_vendor_credits_exchange_rate_source_check;
ALTER TABLE purchases_vendor_credits ADD CONSTRAINT purchases_vendor_credits_exchange_rate_source_check CHECK (
  exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual', 'bill', 'carrying'));
ALTER TABLE purchases_vendor_credits DROP CONSTRAINT purchases_vendor_credits_posted_consistency;
ALTER TABLE purchases_vendor_credits ADD CONSTRAINT purchases_vendor_credits_posted_consistency CHECK (
  (status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)
  AND (status NOT IN ('POSTED', 'VOID') OR (
    number IS NOT NULL AND journal_id IS NOT NULL
    AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL
    AND base_total IS NOT NULL AND amount_unapplied IS NOT NULL AND base_unapplied IS NOT NULL
    AND (origin <> 'supplier_credit_note' OR kind = 'opening' OR vendor_reference IS NOT NULL)
    AND (origin <> 'debit_note' OR render_snapshot IS NOT NULL))));

-- The 0035 guard, with the kind part of the identity and the carrying value immutable once posted.
CREATE OR REPLACE FUNCTION purchases_guard_vendor_credit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_same purchases_vendor_credits;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft vendor credits can be deleted (vendor credit %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.origin, NEW.kind, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.origin, OLD.kind, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'vendor credit % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'vendor credit % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id THEN
    RAISE EXCEPTION 'the PDF of vendor credit % cannot be replaced', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'POSTED'))
    OR (OLD.status = 'POSTED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'vendor credit % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    -- A voided debit note may still receive its PDF once; nothing else changes.
    v_same := NEW;
    v_same.pdf_file_id := OLD.pdf_file_id;
    IF v_same IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'void vendor credit % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.status IN ('POSTED', 'VOID') THEN
    -- Posted: only the unapplied balance, the PDF (once) and the void change.
    IF (NEW.vendor_id, NEW.bill_id, NEW.number, NEW.vendor_reference, NEW.credit_date,
        NEW.currency_code, NEW.rate_override, NEW.rate_override_reason, NEW.exchange_rate,
        NEW.exchange_rate_source, NEW.table_rate, NEW.tax_treatment, NEW.discount_type,
        NEW.discount_value, NEW.memo, NEW.dimension_value_ids, NEW.subtotal, NEW.discount_total,
        NEW.tax_total, NEW.recoverable_tax_total, NEW.total, NEW.base_total, NEW.approval_request_id,
        NEW.submitted_by_user_id, NEW.submitted_at, NEW.posted_by_user_id, NEW.posted_at,
        NEW.journal_id, NEW.accounting_event_id, NEW.render_snapshot, NEW.opening_base_total)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.bill_id, OLD.number, OLD.vendor_reference, OLD.credit_date,
        OLD.currency_code, OLD.rate_override, OLD.rate_override_reason, OLD.exchange_rate,
        OLD.exchange_rate_source, OLD.table_rate, OLD.tax_treatment, OLD.discount_type,
        OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal, OLD.discount_total,
        OLD.tax_total, OLD.recoverable_tax_total, OLD.total, OLD.base_total, OLD.approval_request_id,
        OLD.submitted_by_user_id, OLD.submitted_at, OLD.posted_by_user_id, OLD.posted_at,
        OLD.journal_id, OLD.accounting_event_id, OLD.render_snapshot, OLD.opening_base_total) THEN
      RAISE EXCEPTION 'posted vendor credit % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'POSTED' AND NEW.status = 'VOID'
       AND (OLD.amount_unapplied <> OLD.total OR OLD.base_unapplied <> OLD.base_total) THEN
      RAISE EXCEPTION 'vendor credit % has been applied or refunded and cannot be voided', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
