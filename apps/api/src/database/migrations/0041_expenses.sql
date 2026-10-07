-- 0041_expenses — Phase 4B-9: direct expenses, "spend money" (ADR 0004 P4-37, P4-39, P4-42, P4-44,
-- P4-50, P4-51; architecture rules: Dr expense and input tax / Cr bank or card).
--
-- * Expense: DRAFT -> PENDING_APPROVAL -> POSTED -> VOID, like a bill (P4-15). Approval only
--   authorizes; a separate post (by `expenses.create`) assigns the EXP- number, fixes the rate,
--   snapshots tax and posts through the `purchases.expense_posted` accounting event in one
--   transaction. From then on the expense is immutable; the only change is the void (P4-42:
--   `expenses.void` and a recent password confirmation), which reverses the journal.
-- * An expense settles at once: it credits a bank, cash or credit-card account (P4-26, Decision 42)
--   and never touches the AP control account, so it is not part of the AP subledger or the AP
--   invariant. The payee is a vendor.
-- * Lines, tax recoverability, rates and dimensions follow the bill rules (P4-11, P4-12, P4-16,
--   P4-19, D10); the line columns are the bill's. At most 200 lines (P4-50).
-- * Expenses accept evidence attachments (file link type 'expense'; the receipt, P4-22).

CREATE TABLE purchases_expenses (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                      text NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID')),
  vendor_id                   uuid NOT NULL,
  number                      text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  -- The supplier's receipt or invoice number; optional, kept as entered (trimmed).
  vendor_reference            text CHECK (vendor_reference IS NULL OR length(btrim(vendor_reference)) BETWEEN 1 AND 100),
  expense_date                date NOT NULL,
  currency_code               char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- The bank, cash or card account paid from. Null on a draft: the Purchases default payment
  -- account is used at post when none was chosen.
  payment_account_id          uuid,
  rate_override               numeric(28, 10) CHECK (rate_override IS NULL OR rate_override > 0),
  rate_override_reason        text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  exchange_rate               numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source        text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual')),
  table_rate                  numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  tax_treatment               text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type               text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value              numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  memo                        text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids         uuid[] NOT NULL DEFAULT '{}',
  subtotal                    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total              numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total                   numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  recoverable_tax_total       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax_total >= 0),
  total                       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- From post: the amount paid in base at the expense rate.
  base_total                  numeric(28, 4) CHECK (base_total IS NULL OR base_total >= 0),
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
  CONSTRAINT purchases_expenses_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_expenses_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchases_expenses_payment_account_fkey FOREIGN KEY (payment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_expenses_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT purchases_expenses_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_expenses_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT purchases_expenses_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_expenses_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_expenses_override_reason CHECK ((rate_override IS NULL) = (rate_override_reason IS NULL)),
  CONSTRAINT purchases_expenses_recoverable_within_tax CHECK (recoverable_tax_total <= tax_total),
  CONSTRAINT purchases_expenses_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT purchases_expenses_posted_consistency CHECK (
    (status IN ('POSTED', 'VOID')) = (posted_at IS NOT NULL)
    AND (status NOT IN ('POSTED', 'VOID') OR (
      number IS NOT NULL AND payment_account_id IS NOT NULL AND journal_id IS NOT NULL
      AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL AND base_total IS NOT NULL))),
  CONSTRAINT purchases_expenses_manual_rate CHECK (
    exchange_rate_source IS DISTINCT FROM 'manual' OR rate_override_reason IS NOT NULL),
  CONSTRAINT purchases_expenses_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE UNIQUE INDEX purchases_expenses_number_idx ON purchases_expenses (organization_id, number)
  WHERE number IS NOT NULL;
CREATE INDEX purchases_expenses_list_idx
  ON purchases_expenses (organization_id, status, expense_date DESC, id);
CREATE INDEX purchases_expenses_vendor_idx ON purchases_expenses (organization_id, vendor_id);

CREATE TABLE purchases_expense_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  expense_id                uuid NOT NULL,
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
  CONSTRAINT purchases_expense_lines_expense_fkey FOREIGN KEY (expense_id, organization_id)
    REFERENCES purchases_expenses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT purchases_expense_lines_number_key UNIQUE (expense_id, line_no),
  CONSTRAINT purchases_expense_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT purchases_expense_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_expense_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT purchases_expense_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT purchases_expense_lines_input_account_fkey FOREIGN KEY (input_tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_expense_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchases_expense_lines_tax_consistency CHECK (tax_code_id IS NOT NULL OR tax_amount = 0),
  CONSTRAINT purchases_expense_lines_tax_split CHECK (
    recoverable_tax + non_recoverable_tax = tax_amount
    AND (CASE WHEN tax_recoverable THEN non_recoverable_tax = 0 ELSE recoverable_tax = 0 END))
);
CREATE INDEX purchases_expense_lines_expense_idx
  ON purchases_expense_lines (organization_id, expense_id, line_no);
CREATE INDEX purchases_expense_lines_item_idx ON purchases_expense_lines (organization_id, item_id)
  WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guards: lifecycle, immutability once posted, draft-only deletion
-- ---------------------------------------------------------------------------

CREATE FUNCTION purchases_guard_expense() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft expenses can be deleted (expense %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'expense % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'expense % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'POSTED'))
    OR (OLD.status = 'POSTED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'expense % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void expense % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'POSTED' THEN
    -- Posted: nothing changes except the void.
    IF (NEW.vendor_id, NEW.number, NEW.vendor_reference, NEW.expense_date, NEW.currency_code,
        NEW.payment_account_id, NEW.rate_override, NEW.rate_override_reason, NEW.exchange_rate,
        NEW.exchange_rate_source, NEW.table_rate, NEW.tax_treatment, NEW.discount_type,
        NEW.discount_value, NEW.memo, NEW.dimension_value_ids, NEW.subtotal, NEW.discount_total,
        NEW.tax_total, NEW.recoverable_tax_total, NEW.total, NEW.base_total,
        NEW.approval_request_id, NEW.submitted_by_user_id, NEW.submitted_at,
        NEW.posted_by_user_id, NEW.posted_at, NEW.journal_id, NEW.accounting_event_id)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.number, OLD.vendor_reference, OLD.expense_date, OLD.currency_code,
        OLD.payment_account_id, OLD.rate_override, OLD.rate_override_reason, OLD.exchange_rate,
        OLD.exchange_rate_source, OLD.table_rate, OLD.tax_treatment, OLD.discount_type,
        OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal, OLD.discount_total,
        OLD.tax_total, OLD.recoverable_tax_total, OLD.total, OLD.base_total,
        OLD.approval_request_id, OLD.submitted_by_user_id, OLD.submitted_at,
        OLD.posted_by_user_id, OLD.posted_at, OLD.journal_id, OLD.accounting_event_id) THEN
      RAISE EXCEPTION 'posted expense % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_expenses_guard
  BEFORE UPDATE OR DELETE ON purchases_expenses
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_expense();

-- Lines change only while their expense is a draft or awaiting approval (post snapshots the lines
-- before the expense becomes POSTED). A cascade from a deleted draft finds no parent.
CREATE FUNCTION purchases_guard_expense_line() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.expense_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.expense_id) THEN
    RAISE EXCEPTION 'expense line % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM purchases_expenses
   WHERE id = v_row.expense_id AND organization_id = v_row.organization_id;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'lines of a posted expense are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END;
$$;
CREATE TRIGGER purchases_expense_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchases_expense_lines
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_expense_line();

-- ---------------------------------------------------------------------------
-- Evidence attachments (the receipt)
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill',
                'vendor_credit', 'vendor_payment', 'expense'));

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases_expenses', 'purchases_expense_lines'] LOOP
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
