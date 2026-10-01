-- 0025_sales_opening_invoices — Phase 3B step 16: AR opening invoices (Decision 69; Phase 3B D5).
--
-- An opening invoice (kind 'opening') brings a customer's open balance at conversion into the AR
-- subledger: dated on or before the S8 opening date, no tax and no revenue, it posts Dr AR control /
-- Cr Opening Balance Equity through the same approval and Issue path. A foreign-currency opening
-- invoice may carry an explicit base carrying value (S8-06); otherwise the table rate applies.

ALTER TABLE sales_invoices ADD COLUMN opening_base_total numeric(28, 4)
  CHECK (opening_base_total IS NULL OR opening_base_total > 0);
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_opening_base_kind
  CHECK (opening_base_total IS NULL OR kind = 'opening');
-- 'carrying': the base comes from an explicit carrying value (the rate shown is implied).
ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_exchange_rate_source_check;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_exchange_rate_source_check CHECK (
  exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'carrying'));

-- The 0024 guard, with the carrying value immutable once issued.
CREATE OR REPLACE FUNCTION sales_guard_invoice() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft invoices can be deleted (invoice %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id THEN
    RAISE EXCEPTION 'the PDF of invoice % cannot be replaced', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.kind, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.kind, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'invoice % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'invoice % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'ISSUED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'ISSUED'))
    OR (OLD.status = 'ISSUED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'invoice % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' AND (to_jsonb(NEW) - 'pdf_file_id') IS DISTINCT FROM (to_jsonb(OLD) - 'pdf_file_id') THEN
    RAISE EXCEPTION 'void invoice % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ISSUED' THEN
    IF (NEW.customer_id, NEW.number, NEW.invoice_date, NEW.due_date, NEW.payment_terms_days,
        NEW.currency_code, NEW.exchange_rate, NEW.exchange_rate_source, NEW.tax_treatment,
        NEW.discount_type, NEW.discount_value, NEW.reference, NEW.memo, NEW.dimension_value_ids,
        NEW.subtotal, NEW.discount_total, NEW.tax_total, NEW.total, NEW.base_total,
        NEW.approval_request_id, NEW.submitted_by_user_id, NEW.submitted_at, NEW.issued_by_user_id,
        NEW.issued_at, NEW.journal_id, NEW.accounting_event_id, NEW.render_snapshot, NEW.opening_base_total)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.number, OLD.invoice_date, OLD.due_date, OLD.payment_terms_days,
        OLD.currency_code, OLD.exchange_rate, OLD.exchange_rate_source, OLD.tax_treatment,
        OLD.discount_type, OLD.discount_value, OLD.reference, OLD.memo, OLD.dimension_value_ids,
        OLD.subtotal, OLD.discount_total, OLD.tax_total, OLD.total, OLD.base_total,
        OLD.approval_request_id, OLD.submitted_by_user_id, OLD.submitted_at, OLD.issued_by_user_id,
        OLD.issued_at, OLD.journal_id, OLD.accounting_event_id, OLD.render_snapshot, OLD.opening_base_total) THEN
      RAISE EXCEPTION 'issued invoice % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'VOID' AND (OLD.amount_due <> OLD.total OR OLD.base_due <> OLD.base_total) THEN
      RAISE EXCEPTION 'invoice % has payments or credits applied and cannot be voided', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
