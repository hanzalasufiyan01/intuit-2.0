-- 0035_vendor_credits — Phase 4B-1: vendor credits and debit notes (ADR 0004 P4-11, P4-12, P4-23,
-- P4-24, P4-37, P4-39, P4-42, P4-46, P4-50, P4-51; decided 2026-10-03).
--
-- * One vendor-credit document (P4-23) with origin 'supplier_credit_note' (a credit note we
--   received) or 'debit_note' (one we raise and send). Both reduce what we owe: the journal is the
--   reverse of a bill (Dr AP / Cr purchase lines / Cr recoverable input tax). The open balance is
--   amount_unapplied: credit available to settle bills in the later application stage.
-- * DRAFT -> PENDING_APPROVAL -> POSTED -> VOID. Approval only authorizes; Post (vendor_credits.post,
--   with re-authentication, P4-42) assigns the number (VC- or DN-, P4-51), fixes the rate, snapshots
--   tax and posts through the `purchases.vendor_credit_posted` accounting event. Posted documents are
--   immutable except the unapplied balance (later stages), the debit-note PDF (set once) and the
--   void, which is allowed only while fully unapplied and unrefunded (P4-24).
-- * bill_id is an optional reference to a posted bill of the same vendor and currency; it is not
--   applied here. A linked credit follows the bill's rate; an unlinked foreign-currency credit uses
--   the table rate on its date or a manual override with a reason (P4-16 parity).
-- * vendor_reference (the supplier's credit-note number) is required to post a supplier credit note;
--   debit notes carry our DN- number. Duplicates of a supplier reference are a warning only.
-- * Debit notes get an immutable PDF (legal hold) and email (P4-46): purchases_document_emails.
-- * Attachments: file link type 'vendor_credit'.

CREATE TABLE purchases_vendor_credits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES accounting_settings (organization_id),
  origin                   text NOT NULL CHECK (origin IN ('supplier_credit_note', 'debit_note')),
  status                   text NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID')),
  vendor_id                uuid NOT NULL,
  bill_id                  uuid,
  number                   text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  vendor_reference         text CHECK (vendor_reference IS NULL OR length(btrim(vendor_reference)) BETWEEN 1 AND 100),
  vendor_reference_key     text GENERATED ALWAYS AS (upper(regexp_replace(vendor_reference, '\s', '', 'g'))) STORED,
  credit_date              date NOT NULL,
  currency_code            char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  rate_override            numeric(28, 10) CHECK (rate_override IS NULL OR rate_override > 0),
  rate_override_reason     text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  exchange_rate            numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source     text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual', 'bill')),
  table_rate               numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  tax_treatment            text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type            text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value           numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  memo                     text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids      uuid[] NOT NULL DEFAULT '{}',
  subtotal                 numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total                numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  recoverable_tax_total    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax_total >= 0),
  total                    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  base_total               numeric(28, 4) CHECK (base_total IS NULL OR base_total >= 0),
  -- From post: the credit not yet applied to bills or refunded (later stages change it).
  amount_unapplied         numeric(28, 4),
  base_unapplied           numeric(28, 4),
  approval_request_id      uuid,
  submitted_by_user_id     uuid REFERENCES users (id),
  submitted_at             timestamptz,
  posted_by_user_id        uuid REFERENCES users (id),
  posted_at                timestamptz,
  journal_id               uuid,
  accounting_event_id      uuid,
  -- Debit notes: everything the PDF needs, frozen at post (Decision 21), and the PDF itself.
  render_snapshot          jsonb,
  pdf_file_id              uuid,
  voided_by_user_id        uuid REFERENCES users (id),
  voided_at                timestamptz,
  void_reason              text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id          uuid,
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id       uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL,
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL,
  CONSTRAINT purchases_vendor_credits_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_vendor_credits_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchases_vendor_credits_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT purchases_vendor_credits_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT purchases_vendor_credits_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_vendor_credits_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT purchases_vendor_credits_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_vendor_credits_pdf_fkey FOREIGN KEY (pdf_file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT purchases_vendor_credits_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_vendor_credits_override_reason CHECK ((rate_override IS NULL) = (rate_override_reason IS NULL)),
  -- A credit linked to a bill follows the bill's rate; a manual rate is for unlinked credits only.
  CONSTRAINT purchases_vendor_credits_override_unlinked CHECK (bill_id IS NULL OR rate_override IS NULL),
  CONSTRAINT purchases_vendor_credits_recoverable_within_tax CHECK (recoverable_tax_total <= tax_total),
  CONSTRAINT purchases_vendor_credits_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT purchases_vendor_credits_posted_consistency CHECK (
    (status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)
    AND (status NOT IN ('POSTED', 'VOID') OR (
      number IS NOT NULL AND journal_id IS NOT NULL
      AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL
      AND base_total IS NOT NULL AND amount_unapplied IS NOT NULL AND base_unapplied IS NOT NULL
      AND (origin <> 'supplier_credit_note' OR vendor_reference IS NOT NULL)
      AND (origin <> 'debit_note' OR render_snapshot IS NOT NULL)))),
  CONSTRAINT purchases_vendor_credits_rate_source CHECK (
    (exchange_rate_source IS DISTINCT FROM 'manual' OR rate_override_reason IS NOT NULL)
    AND (exchange_rate_source IS DISTINCT FROM 'bill' OR bill_id IS NOT NULL)),
  CONSTRAINT purchases_vendor_credits_debit_note_output CHECK (
    origin = 'debit_note' OR (render_snapshot IS NULL AND pdf_file_id IS NULL)),
  CONSTRAINT purchases_vendor_credits_pdf_posted CHECK (pdf_file_id IS NULL OR status IN ('POSTED', 'VOID')),
  CONSTRAINT purchases_vendor_credits_open_balance CHECK (
    amount_unapplied IS NULL OR (amount_unapplied >= 0 AND amount_unapplied <= total
                                 AND base_unapplied >= 0 AND base_unapplied <= base_total)),
  CONSTRAINT purchases_vendor_credits_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL
                              AND amount_unapplied = 0 AND base_unapplied = 0)))
);
CREATE UNIQUE INDEX purchases_vendor_credits_number_idx ON purchases_vendor_credits (organization_id, number)
  WHERE number IS NOT NULL;
CREATE INDEX purchases_vendor_credits_reference_idx
  ON purchases_vendor_credits (organization_id, vendor_id, vendor_reference_key) WHERE status <> 'VOID';
CREATE INDEX purchases_vendor_credits_open_idx ON purchases_vendor_credits (organization_id, vendor_id, status);
CREATE INDEX purchases_vendor_credits_list_idx ON purchases_vendor_credits (organization_id, status, credit_date DESC, id);
CREATE INDEX purchases_vendor_credits_bill_idx ON purchases_vendor_credits (organization_id, bill_id)
  WHERE bill_id IS NOT NULL;

CREATE TABLE purchases_vendor_credit_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  vendor_credit_id          uuid NOT NULL,
  line_no                   integer NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  item_id                   uuid,
  description               text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  account_id                uuid,
  quantity                  numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price                numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  discount_type             text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value            numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  amount                    numeric(28, 4) NOT NULL CHECK (amount >= 0),
  line_discount             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  document_discount         numeric(28, 4) NOT NULL DEFAULT 0 CHECK (document_discount >= 0),
  net_amount                numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  tax_code_id               uuid,
  tax_rate_id               uuid,
  tax_rate                  numeric(7, 4) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount                numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  tax_recoverable_override  boolean,
  tax_recoverable           boolean NOT NULL DEFAULT false,
  recoverable_tax           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax >= 0),
  non_recoverable_tax       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (non_recoverable_tax >= 0),
  input_tax_account_id      uuid,
  total                     numeric(28, 4) NOT NULL CHECK (total >= 0),
  dimension_value_ids       uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT purchases_vendor_credit_lines_credit_fkey FOREIGN KEY (vendor_credit_id, organization_id)
    REFERENCES purchases_vendor_credits (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT purchases_vendor_credit_lines_number_key UNIQUE (vendor_credit_id, line_no),
  CONSTRAINT purchases_vendor_credit_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT purchases_vendor_credit_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_vendor_credit_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT purchases_vendor_credit_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT purchases_vendor_credit_lines_input_account_fkey FOREIGN KEY (input_tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_vendor_credit_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_vendor_credit_lines_tax_consistency CHECK (tax_code_id IS NOT NULL OR tax_amount = 0),
  CONSTRAINT purchases_vendor_credit_lines_tax_split CHECK (
    recoverable_tax + non_recoverable_tax = tax_amount
    AND (CASE WHEN tax_recoverable THEN non_recoverable_tax = 0 ELSE recoverable_tax = 0 END))
);
CREATE INDEX purchases_vendor_credit_lines_credit_idx
  ON purchases_vendor_credit_lines (organization_id, vendor_credit_id, line_no);

-- ---------------------------------------------------------------------------
-- Guards: lifecycle, immutability once posted, draft-only deletion
-- ---------------------------------------------------------------------------

CREATE FUNCTION purchases_guard_vendor_credit() RETURNS trigger
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
  IF (NEW.id, NEW.organization_id, NEW.origin, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.origin, OLD.created_at, OLD.created_by_user_id) THEN
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
        NEW.journal_id, NEW.accounting_event_id, NEW.render_snapshot)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.bill_id, OLD.number, OLD.vendor_reference, OLD.credit_date,
        OLD.currency_code, OLD.rate_override, OLD.rate_override_reason, OLD.exchange_rate,
        OLD.exchange_rate_source, OLD.table_rate, OLD.tax_treatment, OLD.discount_type,
        OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal, OLD.discount_total,
        OLD.tax_total, OLD.recoverable_tax_total, OLD.total, OLD.base_total, OLD.approval_request_id,
        OLD.submitted_by_user_id, OLD.submitted_at, OLD.posted_by_user_id, OLD.posted_at,
        OLD.journal_id, OLD.accounting_event_id, OLD.render_snapshot) THEN
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
CREATE TRIGGER purchases_vendor_credits_guard
  BEFORE UPDATE OR DELETE ON purchases_vendor_credits
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_vendor_credit();

CREATE FUNCTION purchases_guard_vendor_credit_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_row    record;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.vendor_credit_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.vendor_credit_id) THEN
    RAISE EXCEPTION 'vendor credit line % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM purchases_vendor_credits
   WHERE id = v_row.vendor_credit_id AND organization_id = v_row.organization_id;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'lines of a posted vendor credit are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END;
$$;
CREATE TRIGGER purchases_vendor_credit_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchases_vendor_credit_lines
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_vendor_credit_line();

-- ---------------------------------------------------------------------------
-- Debit-note email (P4-46): one row per request, sent by a job through the email provider
-- ---------------------------------------------------------------------------

CREATE TABLE purchases_document_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id),
  document_type         text NOT NULL CHECK (document_type IN ('debit_note')),
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
  CONSTRAINT purchases_document_emails_document_fkey FOREIGN KEY (document_id, organization_id)
    REFERENCES purchases_vendor_credits (id, organization_id),
  CONSTRAINT purchases_document_emails_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT purchases_document_emails_sent_consistency CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX purchases_document_emails_document_idx
  ON purchases_document_emails (organization_id, document_type, document_id);

-- Queued -> sent | failed, once; the request itself never changes.
CREATE FUNCTION purchases_guard_document_email() RETURNS trigger
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
CREATE TRIGGER purchases_document_emails_guard
  BEFORE UPDATE OR DELETE ON purchases_document_emails
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_document_email();

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill',
                'vendor_credit'));

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases_vendor_credits', 'purchases_vendor_credit_lines',
                           'purchases_document_emails'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;
-- DELETE: draft credits only (the guards refuse anything else); emails are kept.
GRANT SELECT, INSERT, UPDATE, DELETE ON purchases_vendor_credits, purchases_vendor_credit_lines TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON purchases_document_emails TO intuit_app;
