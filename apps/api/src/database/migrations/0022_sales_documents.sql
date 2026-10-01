-- 0022_sales_documents — Phase 3B steps 6, 7, 12: invoices and credit notes with their lines.
-- Decisions 11, 13, 15, 16, 21, 32–35, 46, 52 (R35, R37); ADR 0003 D3, D8, D15, D16; Phase 3B D1,
-- D5, D7, D9, D10.
--
-- * A draft is edited under optimistic concurrency (Decision 46); totals are computed on the server.
-- * Issue (Phase 3B D1) assigns the number, fixes the table rate on the document date (D9),
--   snapshots tax rates and the rendering data, and posts through an accounting event in the same
--   transaction. From then on the document is immutable (R35) except for its open balance, which
--   receipts, allocations and credit notes change, and — for an unpaid invoice — the void.
-- * Invoice:     DRAFT -> PENDING_APPROVAL -> ISSUED -> VOID (void only when unpaid, D8).
--   Credit note: DRAFT -> PENDING_APPROVAL -> ISSUED (never voided or deleted once issued).
--   "Approved, ready to issue" is derived from the approval request, never stored (D1).
-- * Only drafts can be deleted. Numbers are unique once assigned and not gapless (R37).
-- * Line and document dimensions are stored as value ids and validated by the application; the
--   posted journal carries them with full referential integrity (D10).

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

CREATE TABLE sales_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  kind                  text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'opening')),
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'VOID')),
  customer_id           uuid NOT NULL,
  number                text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  invoice_date          date NOT NULL,
  due_date              date NOT NULL,
  -- The terms the due date came from; NULL when the due date was set directly.
  payment_terms_days    integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  currency_code         char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- Fixed at issue: 1 for the base currency, otherwise the table rate on the invoice date (D9).
  exchange_rate         numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source  text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table')),
  tax_treatment         text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type         text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value        numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  reference             text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                  text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids   uuid[] NOT NULL DEFAULT '{}',
  -- Totals in the invoice currency, computed on the server.
  subtotal              numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total        numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total                 numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- From issue: the posted AR amount in base, and the open balance (document currency and the
  -- historical base still carried on the AR control account).
  base_total            numeric(28, 4) CHECK (base_total IS NULL OR base_total >= 0),
  amount_due            numeric(28, 4),
  base_due              numeric(28, 4),
  approval_request_id   uuid,
  submitted_by_user_id  uuid REFERENCES users (id),
  submitted_at          timestamptz,
  issued_by_user_id     uuid REFERENCES users (id),
  issued_at             timestamptz,
  journal_id            uuid,
  accounting_event_id   uuid,
  -- Everything the PDF needs, frozen at issue (Decision 21).
  render_snapshot       jsonb,
  voided_by_user_id     uuid REFERENCES users (id),
  voided_at             timestamptz,
  void_reason           text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id       uuid,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT sales_invoices_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_invoices_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_invoices_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT sales_invoices_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_invoices_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT sales_invoices_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_invoices_due_after_date CHECK (due_date >= invoice_date),
  CONSTRAINT sales_invoices_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT sales_invoices_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT sales_invoices_issued_consistency CHECK (
    (status IN ('ISSUED', 'VOID')) = (issued_at IS NOT NULL)
    AND (status NOT IN ('ISSUED', 'VOID') OR (
      number IS NOT NULL AND journal_id IS NOT NULL AND exchange_rate IS NOT NULL
      AND exchange_rate_source IS NOT NULL AND base_total IS NOT NULL
      AND amount_due IS NOT NULL AND base_due IS NOT NULL AND render_snapshot IS NOT NULL))),
  CONSTRAINT sales_invoices_open_balance CHECK (
    amount_due IS NULL OR (amount_due >= 0 AND amount_due <= total
                           AND base_due >= 0 AND base_due <= base_total)),
  CONSTRAINT sales_invoices_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL
                              AND amount_due = 0 AND base_due = 0))),
  -- Opening invoices carry no tax and no revenue (Phase 3B D5).
  CONSTRAINT sales_invoices_opening_no_tax CHECK (kind <> 'opening' OR tax_total = 0)
);
CREATE UNIQUE INDEX sales_invoices_number_idx ON sales_invoices (organization_id, number)
  WHERE number IS NOT NULL;
CREATE INDEX sales_invoices_open_idx ON sales_invoices (organization_id, customer_id, status, due_date);
CREATE INDEX sales_invoices_list_idx ON sales_invoices (organization_id, status, invoice_date DESC, id);

CREATE TABLE sales_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  line_no              integer NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  item_id              uuid,
  description          text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  quantity             numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price           numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  discount_type        text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value       numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  -- Quantity x price, rounded to the currency; the line discount; the share of the document
  -- discount (Decision 35); then tax per line (Decision 33).
  amount               numeric(28, 4) NOT NULL CHECK (amount >= 0),
  line_discount        numeric(28, 4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  document_discount    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (document_discount >= 0),
  net_amount           numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  tax_code_id          uuid,
  -- The rate version used: set on drafts for display, fixed at issue (Decision 15).
  tax_rate_id          uuid,
  tax_rate             numeric(7, 4) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total                numeric(28, 4) NOT NULL CHECK (total >= 0),
  revenue_account_id   uuid,
  dimension_value_ids  uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT sales_invoice_lines_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT sales_invoice_lines_number_key UNIQUE (invoice_id, line_no),
  CONSTRAINT sales_invoice_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT sales_invoice_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT sales_invoice_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT sales_invoice_lines_revenue_account_fkey FOREIGN KEY (revenue_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_invoice_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT sales_invoice_lines_tax_consistency CHECK (tax_code_id IS NOT NULL OR tax_amount = 0)
);
CREATE INDEX sales_invoice_lines_invoice_idx ON sales_invoice_lines (organization_id, invoice_id, line_no);
CREATE INDEX sales_invoice_lines_item_idx ON sales_invoice_lines (organization_id, item_id)
  WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Credit notes (Decision 41; D7)
-- ---------------------------------------------------------------------------

CREATE TABLE sales_credit_notes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ISSUED')),
  customer_id           uuid NOT NULL,
  -- The invoice being credited, if any: the credit then follows its rate and is applied to it.
  invoice_id            uuid,
  number                text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  credit_date           date NOT NULL,
  currency_code         char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  exchange_rate         numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source  text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'invoice')),
  tax_treatment         text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type         text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value        numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  reference             text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                  text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids   uuid[] NOT NULL DEFAULT '{}',
  subtotal              numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total        numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total                 numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  base_total            numeric(28, 4) CHECK (base_total IS NULL OR base_total >= 0),
  -- From issue: the credit not yet applied to invoices (customer credit, Decision 38).
  amount_unapplied      numeric(28, 4),
  base_unapplied        numeric(28, 4),
  approval_request_id   uuid,
  submitted_by_user_id  uuid REFERENCES users (id),
  submitted_at          timestamptz,
  issued_by_user_id     uuid REFERENCES users (id),
  issued_at             timestamptz,
  journal_id            uuid,
  accounting_event_id   uuid,
  render_snapshot       jsonb,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT sales_credit_notes_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_credit_notes_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_credit_notes_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id),
  CONSTRAINT sales_credit_notes_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT sales_credit_notes_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_credit_notes_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT sales_credit_notes_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT sales_credit_notes_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT sales_credit_notes_issued_consistency CHECK (
    (status = 'ISSUED') = (issued_at IS NOT NULL)
    AND (status <> 'ISSUED' OR (
      number IS NOT NULL AND journal_id IS NOT NULL AND exchange_rate IS NOT NULL
      AND exchange_rate_source IS NOT NULL AND base_total IS NOT NULL
      AND amount_unapplied IS NOT NULL AND base_unapplied IS NOT NULL AND render_snapshot IS NOT NULL))),
  CONSTRAINT sales_credit_notes_open_balance CHECK (
    amount_unapplied IS NULL OR (amount_unapplied >= 0 AND amount_unapplied <= total
                                 AND base_unapplied >= 0 AND base_unapplied <= base_total))
);
CREATE UNIQUE INDEX sales_credit_notes_number_idx ON sales_credit_notes (organization_id, number)
  WHERE number IS NOT NULL;
CREATE INDEX sales_credit_notes_open_idx ON sales_credit_notes (organization_id, customer_id, status);
CREATE INDEX sales_credit_notes_list_idx ON sales_credit_notes (organization_id, status, credit_date DESC, id);
CREATE INDEX sales_credit_notes_invoice_idx ON sales_credit_notes (organization_id, invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE TABLE sales_credit_note_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  credit_note_id       uuid NOT NULL,
  line_no              integer NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  item_id              uuid,
  description          text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  quantity             numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price           numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  discount_type        text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value       numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  amount               numeric(28, 4) NOT NULL CHECK (amount >= 0),
  line_discount        numeric(28, 4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  document_discount    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (document_discount >= 0),
  net_amount           numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  tax_code_id          uuid,
  tax_rate_id          uuid,
  tax_rate             numeric(7, 4) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total                numeric(28, 4) NOT NULL CHECK (total >= 0),
  revenue_account_id   uuid,
  dimension_value_ids  uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT sales_credit_note_lines_note_fkey FOREIGN KEY (credit_note_id, organization_id)
    REFERENCES sales_credit_notes (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT sales_credit_note_lines_number_key UNIQUE (credit_note_id, line_no),
  CONSTRAINT sales_credit_note_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT sales_credit_note_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT sales_credit_note_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT sales_credit_note_lines_revenue_account_fkey FOREIGN KEY (revenue_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_credit_note_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT sales_credit_note_lines_tax_consistency CHECK (tax_code_id IS NOT NULL OR tax_amount = 0)
);
CREATE INDEX sales_credit_note_lines_note_idx ON sales_credit_note_lines (organization_id, credit_note_id, line_no);

-- ---------------------------------------------------------------------------
-- Guards: lifecycle, immutability once issued (R35), draft-only deletion
-- ---------------------------------------------------------------------------

CREATE FUNCTION sales_guard_invoice() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft invoices can be deleted (invoice %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
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
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void invoice % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ISSUED' THEN
    -- Issued: only the open balance changes, and an unpaid invoice may be voided (D8).
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
CREATE TRIGGER sales_invoices_guard
  BEFORE UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION sales_guard_invoice();

CREATE FUNCTION sales_guard_credit_note() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft credit notes can be deleted (credit note %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
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
    -- Issued: only the unapplied credit changes (Decision 41).
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
CREATE TRIGGER sales_credit_notes_guard
  BEFORE UPDATE OR DELETE ON sales_credit_notes
  FOR EACH ROW EXECUTE FUNCTION sales_guard_credit_note();

-- Lines change only while their document is a draft or awaiting approval (issue snapshots the
-- lines before the document becomes ISSUED). A cascade from a deleted draft finds no parent.
CREATE FUNCTION sales_guard_document_line() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id) IS DISTINCT FROM (OLD.id, OLD.organization_id) THEN
    RAISE EXCEPTION 'line % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'sales_invoice_lines' THEN
    IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
      RAISE EXCEPTION 'line % cannot move to another invoice', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM sales_invoices
     WHERE id = v_row.invoice_id AND organization_id = v_row.organization_id;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.credit_note_id IS DISTINCT FROM OLD.credit_note_id THEN
      RAISE EXCEPTION 'line % cannot move to another credit note', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM sales_credit_notes
     WHERE id = v_row.credit_note_id AND organization_id = v_row.organization_id;
  END IF;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'lines of an issued document are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END;
$$;
CREATE TRIGGER sales_invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION sales_guard_document_line();
CREATE TRIGGER sales_credit_note_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION sales_guard_document_line();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_invoices', 'sales_invoice_lines', 'sales_credit_notes',
                           'sales_credit_note_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    -- DELETE: drafts only (the guards refuse anything else).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO intuit_app', t);
  END LOOP;
END;
$$;
