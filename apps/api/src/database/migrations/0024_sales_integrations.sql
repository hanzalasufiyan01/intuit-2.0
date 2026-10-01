-- 0024_sales_integrations — Phase 3B steps 14, 15, 18: documents, email and data exchange.
-- Decisions 21, 24, 29, 43; ADR 0003 D10; Phase 3B D14, E4; brief §Z, §AA, §AC.
--
-- * File links: invoices, credit notes and receipts accept attachments (S5 targets), and an
--   issued invoice or credit note gets its PDF, rendered from its frozen snapshot and stored
--   under legal hold (Decisions 21, 29). The PDF is set once and never replaced.
-- * sales_document_emails: each request to email a document, sent by a job through the email
--   provider with the PDF attached (E4). The production vendor stays deferred (U18).
-- * Data exchange (S6): Sales imports (customers, items, opening invoices as drafts) and exports
--   (customers, items, invoices, receipts, AR aging). CSV only; XLSX awaits Decision 62.

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt'));

ALTER TABLE sales_invoices ADD COLUMN pdf_file_id uuid;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_pdf_fkey
  FOREIGN KEY (pdf_file_id, organization_id) REFERENCES files (id, organization_id);
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_pdf_issued
  CHECK (pdf_file_id IS NULL OR status IN ('ISSUED', 'VOID'));
ALTER TABLE sales_credit_notes ADD COLUMN pdf_file_id uuid;
ALTER TABLE sales_credit_notes ADD CONSTRAINT sales_credit_notes_pdf_fkey
  FOREIGN KEY (pdf_file_id, organization_id) REFERENCES files (id, organization_id);
ALTER TABLE sales_credit_notes ADD CONSTRAINT sales_credit_notes_pdf_issued
  CHECK (pdf_file_id IS NULL OR status = 'ISSUED');

-- The 0022 guards, plus: the PDF of an issued (or since voided) document is attached once and
-- never replaced (Decision 21). Everything else is unchanged.
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
        NEW.issued_at, NEW.journal_id, NEW.accounting_event_id, NEW.render_snapshot)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.number, OLD.invoice_date, OLD.due_date, OLD.payment_terms_days,
        OLD.currency_code, OLD.exchange_rate, OLD.exchange_rate_source, OLD.tax_treatment,
        OLD.discount_type, OLD.discount_value, OLD.reference, OLD.memo, OLD.dimension_value_ids,
        OLD.subtotal, OLD.discount_total, OLD.tax_total, OLD.total, OLD.base_total,
        OLD.approval_request_id, OLD.submitted_by_user_id, OLD.submitted_at, OLD.issued_by_user_id,
        OLD.issued_at, OLD.journal_id, OLD.accounting_event_id, OLD.render_snapshot) THEN
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

CREATE OR REPLACE FUNCTION sales_guard_credit_note() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft credit notes can be deleted (credit note %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id THEN
    RAISE EXCEPTION 'the PDF of credit note % cannot be replaced', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'credit note % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'credit note % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'ISSUED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'ISSUED'))) THEN
    RAISE EXCEPTION 'credit note % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ISSUED' THEN
    IF (NEW.status, NEW.customer_id, NEW.invoice_id, NEW.number, NEW.credit_date, NEW.currency_code,
        NEW.exchange_rate, NEW.exchange_rate_source, NEW.tax_treatment, NEW.discount_type,
        NEW.discount_value, NEW.reference, NEW.memo, NEW.dimension_value_ids, NEW.subtotal,
        NEW.discount_total, NEW.tax_total, NEW.total, NEW.base_total, NEW.approval_request_id,
        NEW.submitted_by_user_id, NEW.submitted_at, NEW.issued_by_user_id, NEW.issued_at,
        NEW.journal_id, NEW.accounting_event_id, NEW.render_snapshot)
       IS DISTINCT FROM
       (OLD.status, OLD.customer_id, OLD.invoice_id, OLD.number, OLD.credit_date, OLD.currency_code,
        OLD.exchange_rate, OLD.exchange_rate_source, OLD.tax_treatment, OLD.discount_type,
        OLD.discount_value, OLD.reference, OLD.memo, OLD.dimension_value_ids, OLD.subtotal,
        OLD.discount_total, OLD.tax_total, OLD.total, OLD.base_total, OLD.approval_request_id,
        OLD.submitted_by_user_id, OLD.submitted_at, OLD.issued_by_user_id, OLD.issued_at,
        OLD.journal_id, OLD.accounting_event_id, OLD.render_snapshot) THEN
      RAISE EXCEPTION 'issued credit note % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Document email (step 15, E4)
-- ---------------------------------------------------------------------------

CREATE TABLE sales_document_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id),
  document_type         text NOT NULL CHECK (document_type IN ('invoice', 'credit_note')),
  document_id           uuid NOT NULL,
  recipient             text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
  subject               text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  message               text NOT NULL DEFAULT '' CHECK (length(message) <= 4000),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  job_id                uuid,
  file_id               uuid,
  requested_by_user_id  uuid NOT NULL REFERENCES users (id),
  requested_at          timestamptz NOT NULL,
  sent_at               timestamptz,
  CONSTRAINT sales_document_emails_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT sales_document_emails_sent_consistency CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX sales_document_emails_document_idx
  ON sales_document_emails (organization_id, document_type, document_id);

-- Queued -> sent | failed, once; the request itself never changes.
CREATE FUNCTION sales_guard_document_email() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document emails are kept' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'queued'
     OR (NEW.id, NEW.organization_id, NEW.document_type, NEW.document_id, NEW.recipient, NEW.subject,
         NEW.message, NEW.requested_by_user_id, NEW.requested_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.document_type, OLD.document_id, OLD.recipient, OLD.subject,
         OLD.message, OLD.requested_by_user_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'document email % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_document_emails_guard
  BEFORE UPDATE OR DELETE ON sales_document_emails
  FOR EACH ROW EXECUTE FUNCTION sales_guard_document_email();
CREATE TRIGGER sales_document_emails_no_truncate
  BEFORE TRUNCATE ON sales_document_emails
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
ALTER TABLE sales_document_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_document_emails_tenant ON sales_document_emails FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON sales_document_emails FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON sales_document_emails TO intuit_app;

-- ---------------------------------------------------------------------------
-- Data exchange domains (step 18; S6)
-- ---------------------------------------------------------------------------

ALTER TABLE import_batches DROP CONSTRAINT import_batches_domain_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances', 'customers', 'sales_items', 'opening_invoices'));
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_domain_check;
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances', 'customers', 'sales_items', 'opening_invoices'));
ALTER TABLE exports DROP CONSTRAINT exports_domain_check;
ALTER TABLE exports ADD CONSTRAINT exports_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors', 'opening_balances',
  'customers', 'sales_items', 'invoices', 'receipts', 'ar_aging'));
