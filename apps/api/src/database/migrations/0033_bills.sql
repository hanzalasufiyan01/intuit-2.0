-- 0033_bills — Phase 4A-5: bills (ADR 0004 P4-11, P4-12, P4-15 to P4-22, P4-37, P4-50, P4-51).
--
-- * Bill: DRAFT -> PENDING_APPROVAL -> POSTED -> VOID (P4-15). Approval only authorizes; a
--   separate Post (`bills.post`) assigns the number, fixes the rate, snapshots tax and posts
--   through the `purchases.bill_posted` accounting event in one transaction. From then on the
--   bill is immutable except for its open balance (payments, a later stage) and the void, which is
--   allowed only while unpaid (P4-21). "Ready to post" is derived, never stored.
-- * vendor_reference (the supplier's invoice number) is optional on drafts and required to post a
--   standard bill (P4-17). Its normalized form (case and whitespace ignored) is generated and
--   indexed for the duplicate check at post (P4-18), which blocks unless confirmed with a reason.
-- * Rates (P4-16): the table rate on the bill date by default; an optional manual override with a
--   mandatory reason. Posting records the rate used, its source and the table rate.
-- * Lines (P4-11, P4-12): the purchase account (P4-19), tax code and rate version, and the
--   line's tax recoverability: the user's explicit choice (if any) and the resolved flag, with the
--   tax split into recoverable (input tax account) and non-recoverable (capitalized) parts. The
--   input tax account used is snapshotted at post.
-- * At most 200 lines per bill (P4-50). Only drafts can be deleted. Numbers are unique once
--   assigned and not gapless (R37).
-- * Bills accept evidence attachments (file link type 'bill', P4-22).

CREATE TABLE purchases_bills (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES accounting_settings (organization_id),
  -- Opening bills (P4-35) are a later stage.
  kind                        text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard')),
  status                      text NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID')),
  vendor_id                   uuid NOT NULL,
  number                      text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  -- Kept exactly as entered (trimmed); the key ignores case and whitespace (P4-18).
  vendor_reference            text CHECK (vendor_reference IS NULL OR length(btrim(vendor_reference)) BETWEEN 1 AND 100),
  vendor_reference_key        text GENERATED ALWAYS AS (upper(regexp_replace(vendor_reference, '\s', '', 'g'))) STORED,
  bill_date                   date NOT NULL,
  due_date                    date NOT NULL,
  payment_terms_days          integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  currency_code               char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- A requested manual rate (P4-16): set on the draft with its mandatory reason.
  rate_override               numeric(28, 10) CHECK (rate_override IS NULL OR rate_override > 0),
  rate_override_reason        text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  -- Fixed at post: the rate used, where it came from and the table rate on the bill date.
  exchange_rate               numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source        text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual')),
  table_rate                  numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  tax_treatment               text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type               text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value              numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  memo                        text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids         uuid[] NOT NULL DEFAULT '{}',
  -- Totals in the bill currency, computed on the server.
  subtotal                    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total              numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total                   numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  recoverable_tax_total       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax_total >= 0),
  total                       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- From post: the AP amount in base, and the open balance (payments, a later stage).
  base_total                  numeric(28, 4) CHECK (base_total IS NULL OR base_total >= 0),
  amount_due                  numeric(28, 4),
  base_due                    numeric(28, 4),
  -- The audited reason a duplicate supplier reference was confirmed at post (P4-18).
  duplicate_confirmed_reason  text CHECK (duplicate_confirmed_reason IS NULL OR length(btrim(duplicate_confirmed_reason)) BETWEEN 1 AND 500),
  approval_request_id         uuid,
  submitted_by_user_id        uuid REFERENCES users (id),
  submitted_at                timestamptz,
  posted_by_user_id           uuid REFERENCES users (id),
  posted_at                   timestamptz,
  journal_id                  uuid,
  accounting_event_id         uuid,
  voided_by_user_id           uuid REFERENCES users (id),
  voided_at                   timestamptz,
  void_reason                 text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id             uuid,
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id          uuid NOT NULL REFERENCES users (id),
  created_at                  timestamptz NOT NULL,
  updated_by_user_id          uuid REFERENCES users (id),
  updated_at                  timestamptz NOT NULL,
  CONSTRAINT purchases_bills_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_bills_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchases_bills_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT purchases_bills_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_bills_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT purchases_bills_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_bills_due_after_date CHECK (due_date >= bill_date),
  CONSTRAINT purchases_bills_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_bills_override_reason CHECK ((rate_override IS NULL) = (rate_override_reason IS NULL)),
  CONSTRAINT purchases_bills_recoverable_within_tax CHECK (recoverable_tax_total <= tax_total),
  CONSTRAINT purchases_bills_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT purchases_bills_posted_consistency CHECK (
    (status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)
    AND (status NOT IN ('POSTED', 'VOID') OR (
      number IS NOT NULL AND vendor_reference IS NOT NULL AND journal_id IS NOT NULL
      AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL
      AND base_total IS NOT NULL AND amount_due IS NOT NULL AND base_due IS NOT NULL))),
  CONSTRAINT purchases_bills_manual_rate CHECK (
    exchange_rate_source IS DISTINCT FROM 'manual' OR rate_override_reason IS NOT NULL),
  CONSTRAINT purchases_bills_open_balance CHECK (
    amount_due IS NULL OR (amount_due >= 0 AND amount_due <= total
                           AND base_due >= 0 AND base_due <= base_total)),
  CONSTRAINT purchases_bills_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL
                              AND amount_due = 0 AND base_due = 0)))
);
CREATE UNIQUE INDEX purchases_bills_number_idx ON purchases_bills (organization_id, number)
  WHERE number IS NOT NULL;
-- P4-18: the duplicate check looks up non-void bills by vendor and normalized reference.
CREATE INDEX purchases_bills_reference_idx
  ON purchases_bills (organization_id, vendor_id, vendor_reference_key) WHERE status <> 'VOID';
CREATE INDEX purchases_bills_open_idx ON purchases_bills (organization_id, vendor_id, status, due_date);
CREATE INDEX purchases_bills_list_idx ON purchases_bills (organization_id, status, bill_date DESC, id);

CREATE TABLE purchases_bill_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  bill_id                   uuid NOT NULL,
  line_no                   integer NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  item_id                   uuid,
  description               text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  -- The purchase account (P4-19), resolved from the line, item, vendor or Purchases default.
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
  -- The rate version used: set on drafts for display, fixed at post (Decision 15).
  tax_rate_id               uuid,
  tax_rate                  numeric(7, 4) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount                numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  -- P4-12: the user's explicit choice (NULL: the default applies) and the resolved flag.
  tax_recoverable_override  boolean,
  tax_recoverable           boolean NOT NULL DEFAULT false,
  recoverable_tax           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax >= 0),
  non_recoverable_tax       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (non_recoverable_tax >= 0),
  -- P4-11: the input tax account recoverable tax posted to, snapshotted at post.
  input_tax_account_id      uuid,
  total                     numeric(28, 4) NOT NULL CHECK (total >= 0),
  dimension_value_ids       uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT purchases_bill_lines_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT purchases_bill_lines_number_key UNIQUE (bill_id, line_no),
  CONSTRAINT purchases_bill_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT purchases_bill_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_bill_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT purchases_bill_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT purchases_bill_lines_input_account_fkey FOREIGN KEY (input_tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_bill_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_bill_lines_tax_consistency CHECK (tax_code_id IS NOT NULL OR tax_amount = 0),
  -- All of a line's tax is either recoverable or not (P4-12).
  CONSTRAINT purchases_bill_lines_tax_split CHECK (
    recoverable_tax + non_recoverable_tax = tax_amount
    AND (CASE WHEN tax_recoverable THEN non_recoverable_tax = 0 ELSE recoverable_tax = 0 END))
);
CREATE INDEX purchases_bill_lines_bill_idx ON purchases_bill_lines (organization_id, bill_id, line_no);
CREATE INDEX purchases_bill_lines_item_idx ON purchases_bill_lines (organization_id, item_id)
  WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guards: lifecycle, immutability once posted, draft-only deletion
-- ---------------------------------------------------------------------------

CREATE FUNCTION purchases_guard_bill() RETURNS trigger
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
        NEW.accounting_event_id)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.number, OLD.vendor_reference, OLD.bill_date, OLD.due_date,
        OLD.payment_terms_days, OLD.currency_code, OLD.rate_override, OLD.rate_override_reason,
        OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate, OLD.tax_treatment,
        OLD.discount_type, OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal,
        OLD.discount_total, OLD.tax_total, OLD.recoverable_tax_total, OLD.total, OLD.base_total,
        OLD.duplicate_confirmed_reason, OLD.approval_request_id, OLD.submitted_by_user_id,
        OLD.submitted_at, OLD.posted_by_user_id, OLD.posted_at, OLD.journal_id,
        OLD.accounting_event_id) THEN
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
CREATE TRIGGER purchases_bills_guard
  BEFORE UPDATE OR DELETE ON purchases_bills
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_bill();

-- Lines change only while their bill is a draft or awaiting approval (post snapshots the lines
-- before the bill becomes POSTED). A cascade from a deleted draft finds no parent.
CREATE FUNCTION purchases_guard_bill_line() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.bill_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.bill_id) THEN
    RAISE EXCEPTION 'bill line % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM purchases_bills
   WHERE id = v_row.bill_id AND organization_id = v_row.organization_id;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'lines of a posted bill are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END;
$$;
CREATE TRIGGER purchases_bill_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchases_bill_lines
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_bill_line();

-- ---------------------------------------------------------------------------
-- Evidence attachments (P4-22)
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill'));

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases_bills', 'purchases_bill_lines'] LOOP
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
