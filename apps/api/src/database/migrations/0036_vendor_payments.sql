-- 0036_vendor_payments — Phase 4B-2: vendor payments, allocations, prepayments and realized FX
-- (ADR 0004 P4-25 to P4-29, P4-33, P4-34, P4-37, P4-39, P4-42, P4-50, P4-51; 4B-2 decisions
-- C1-C3, A1-A6 approved 2026-10-04).
--
-- * purchases_payments: one transaction currency per payment. DRAFT -> PENDING_APPROVAL ->
--   RECORDED -> VOID. Drafts carry planned allocations (P4-25); approval only authorizes; Record
--   (vendor_payments.create) fixes the rate (the table rate on the payment date, or a manual
--   override with a mandatory reason, the table rate kept, P4-27), resolves the payment account
--   (the Purchases default or an override, P4-28), takes the PAY- number and posts through the
--   `purchases.payment_recorded` accounting event: Dr AP per bill at the bill's historical base,
--   Dr AP for any excess (a prepayment: a vendor debit balance on the AP control account, P4-29),
--   Cr the payment account at the payment rate, and the net realized FX as ONE base-only line
--   (C1). Recorded payments are immutable except the unallocated (prepayment) balance and the void.
-- * purchases_payment_planned_allocations: a draft's planned bills; changeable only while the
--   payment is a draft and kept as the plan afterwards.
-- * purchases_allocations: append-only settlement history. A payment settles posted bills
--   (mode 'payment'); a vendor credit or a payment's prepayment is applied to posted bills later
--   (mode 'credit', grouped by application_id). Each row keeps its own realized FX with the AP
--   sign: fx_difference = base_relieved - source_base (positive = gain). A void appends reversing
--   rows (reverses_allocation_id); an allocation is reversed at most once.
-- * Payment allocations target bills only: a payment is never allocated to a vendor credit (C2).

CREATE TABLE purchases_payments (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                     text NOT NULL DEFAULT 'DRAFT'
                               CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'RECORDED', 'VOID')),
  number                     text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  vendor_id                  uuid NOT NULL,
  payment_date               date NOT NULL,
  currency_code              char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount                     numeric(28, 4) NOT NULL CHECK (amount > 0),
  -- NULL on a draft means the Purchases default payment account at record (P4-28).
  payment_account_id         uuid,
  payment_account_overridden boolean,
  -- A draft's manual rate and its mandatory reason (P4-27).
  rate_override              numeric(28, 10) CHECK (rate_override IS NULL OR rate_override > 0),
  rate_override_reason       text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  -- Fixed at record: the rate used, its source and the table rate on the payment date.
  exchange_rate              numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source       text CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('base', 'table', 'manual')),
  table_rate                 numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  base_amount                numeric(28, 4) CHECK (base_amount IS NULL OR base_amount >= 0),
  -- The prepayment still to apply (payment currency) and the base it carries on AP (I-1).
  amount_unallocated         numeric(28, 4),
  base_unallocated           numeric(28, 4),
  reference                  text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                       text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  approval_request_id        uuid,
  submitted_by_user_id       uuid REFERENCES users (id),
  submitted_at               timestamptz,
  recorded_by_user_id        uuid REFERENCES users (id),
  recorded_at                timestamptz,
  journal_id                 uuid,
  accounting_event_id        uuid,
  voided_by_user_id          uuid REFERENCES users (id),
  voided_at                  timestamptz,
  void_reason                text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id            uuid,
  version                    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id         uuid NOT NULL REFERENCES users (id),
  created_at                 timestamptz NOT NULL,
  updated_by_user_id         uuid REFERENCES users (id),
  updated_at                 timestamptz NOT NULL,
  CONSTRAINT purchases_payments_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_payments_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchases_payments_account_fkey FOREIGN KEY (payment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_payments_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT purchases_payments_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_payments_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT purchases_payments_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_payments_override_reason CHECK ((rate_override IS NULL) = (rate_override_reason IS NULL)),
  CONSTRAINT purchases_payments_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT purchases_payments_recorded_consistency CHECK (
    (status IN ('RECORDED', 'VOID')) = (recorded_at IS NOT NULL)
    AND (status NOT IN ('RECORDED', 'VOID') OR (
      number IS NOT NULL AND payment_account_id IS NOT NULL AND payment_account_overridden IS NOT NULL
      AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL AND base_amount IS NOT NULL
      AND amount_unallocated IS NOT NULL AND base_unallocated IS NOT NULL
      AND journal_id IS NOT NULL AND accounting_event_id IS NOT NULL))),
  CONSTRAINT purchases_payments_rate_source CHECK (
    exchange_rate_source IS DISTINCT FROM 'manual' OR rate_override_reason IS NOT NULL),
  CONSTRAINT purchases_payments_open_balance CHECK (
    amount_unallocated IS NULL OR (amount_unallocated >= 0 AND amount_unallocated <= amount
                                   AND base_unallocated >= 0 AND base_unallocated <= base_amount)),
  CONSTRAINT purchases_payments_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL
                              AND amount_unallocated = 0 AND base_unallocated = 0)))
);
CREATE UNIQUE INDEX purchases_payments_number_idx ON purchases_payments (organization_id, number)
  WHERE number IS NOT NULL;
CREATE INDEX purchases_payments_vendor_idx ON purchases_payments (organization_id, vendor_id, status);
CREATE INDEX purchases_payments_list_idx ON purchases_payments (organization_id, payment_date DESC, id);

CREATE TABLE purchases_payment_planned_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  payment_id       uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no BETWEEN 1 AND 497),
  bill_id          uuid NOT NULL,
  amount           numeric(28, 4) NOT NULL CHECK (amount > 0),
  CONSTRAINT purchases_payment_planned_payment_fkey FOREIGN KEY (payment_id, organization_id)
    REFERENCES purchases_payments (id, organization_id),
  CONSTRAINT purchases_payment_planned_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT purchases_payment_planned_line_key UNIQUE (payment_id, line_no),
  CONSTRAINT purchases_payment_planned_bill_key UNIQUE (payment_id, bill_id)
);

CREATE TABLE purchases_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  -- Where the money or credit comes from.
  source_type            text NOT NULL CHECK (source_type IN ('payment', 'vendor_credit')),
  payment_id             uuid,
  vendor_credit_id       uuid,
  bill_id                uuid NOT NULL,
  -- 'payment': settled when the payment was recorded; 'credit': a vendor credit or a prepayment
  -- applied later, grouped by its application.
  mode                   text NOT NULL CHECK (mode IN ('payment', 'credit')),
  application_id         uuid,
  allocation_date        date NOT NULL,
  currency_code          char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- Positive when applied; a reversing row carries the negated amounts.
  amount                 numeric(28, 4) NOT NULL CHECK (amount <> 0),
  -- Historical base relieved on the bill, and the base value the source gave up.
  base_relieved          numeric(28, 4) NOT NULL,
  source_base            numeric(28, 4) NOT NULL,
  -- Realized FX with the AP sign (ADR 0004): base relieved minus source base (positive = gain).
  fx_difference          numeric(28, 4) NOT NULL,
  reverses_allocation_id uuid,
  journal_id             uuid NOT NULL,
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  CONSTRAINT purchases_allocations_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_allocations_source_consistency CHECK (
    (source_type = 'payment' AND payment_id IS NOT NULL AND vendor_credit_id IS NULL)
    OR (source_type = 'vendor_credit' AND vendor_credit_id IS NOT NULL AND payment_id IS NULL)),
  CONSTRAINT purchases_allocations_mode_consistency CHECK (source_type = 'payment' OR mode = 'credit'),
  CONSTRAINT purchases_allocations_application_consistency CHECK ((mode = 'credit') = (application_id IS NOT NULL)),
  CONSTRAINT purchases_allocations_fx_consistency CHECK (fx_difference = base_relieved - source_base),
  CONSTRAINT purchases_allocations_sign_consistency CHECK (
    (reverses_allocation_id IS NULL AND amount > 0) OR (reverses_allocation_id IS NOT NULL AND amount < 0)),
  CONSTRAINT purchases_allocations_payment_fkey FOREIGN KEY (payment_id, organization_id)
    REFERENCES purchases_payments (id, organization_id),
  CONSTRAINT purchases_allocations_vendor_credit_fkey FOREIGN KEY (vendor_credit_id, organization_id)
    REFERENCES purchases_vendor_credits (id, organization_id),
  CONSTRAINT purchases_allocations_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT purchases_allocations_reverses_fkey FOREIGN KEY (reverses_allocation_id, organization_id)
    REFERENCES purchases_allocations (id, organization_id),
  CONSTRAINT purchases_allocations_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
-- An allocation is reversed at most once.
CREATE UNIQUE INDEX purchases_allocations_reversal_idx ON purchases_allocations (reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;
CREATE INDEX purchases_allocations_bill_idx ON purchases_allocations (organization_id, bill_id);
CREATE INDEX purchases_allocations_payment_idx ON purchases_allocations (organization_id, payment_id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX purchases_allocations_vendor_credit_idx ON purchases_allocations (organization_id, vendor_credit_id)
  WHERE vendor_credit_id IS NOT NULL;
CREATE INDEX purchases_allocations_application_idx ON purchases_allocations (organization_id, application_id)
  WHERE application_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- Payments: drafts change and may be deleted; recorded payments are immutable except the
-- prepayment balance and the void (P4-33).
CREATE FUNCTION purchases_guard_payment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft payments can be deleted; recorded payments are voided'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'payment % identity is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void payment % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'RECORDED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'RECORDED'))
    OR (OLD.status = 'RECORDED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'payment % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'RECORDED' THEN
    IF (NEW.number, NEW.vendor_id, NEW.payment_date, NEW.currency_code, NEW.amount,
        NEW.payment_account_id, NEW.payment_account_overridden, NEW.rate_override,
        NEW.rate_override_reason, NEW.exchange_rate, NEW.exchange_rate_source, NEW.table_rate,
        NEW.base_amount, NEW.reference, NEW.memo, NEW.approval_request_id,
        NEW.submitted_by_user_id, NEW.submitted_at, NEW.recorded_by_user_id, NEW.recorded_at,
        NEW.journal_id, NEW.accounting_event_id)
       IS DISTINCT FROM
       (OLD.number, OLD.vendor_id, OLD.payment_date, OLD.currency_code, OLD.amount,
        OLD.payment_account_id, OLD.payment_account_overridden, OLD.rate_override,
        OLD.rate_override_reason, OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate,
        OLD.base_amount, OLD.reference, OLD.memo, OLD.approval_request_id,
        OLD.submitted_by_user_id, OLD.submitted_at, OLD.recorded_by_user_id, OLD.recorded_at,
        OLD.journal_id, OLD.accounting_event_id) THEN
      RAISE EXCEPTION 'recorded payment % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_payments_guard
  BEFORE UPDATE OR DELETE ON purchases_payments
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_payment();

-- Planned allocations change only while their payment is a draft.
CREATE FUNCTION purchases_guard_planned_allocation() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_row purchases_payment_planned_allocations;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'UPDATE' AND (NEW.payment_id, NEW.organization_id) IS DISTINCT FROM (OLD.payment_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'a planned allocation cannot move to another payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM purchases_payments
   WHERE id = v_row.payment_id AND organization_id = v_row.organization_id;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the planned allocations of payment % can change only while it is a draft', v_row.payment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER purchases_payment_planned_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchases_payment_planned_allocations
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_planned_allocation();

CREATE TRIGGER purchases_allocations_no_update
  BEFORE UPDATE OR DELETE ON purchases_allocations
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases_payments', 'purchases_payment_planned_allocations',
                           'purchases_allocations'] LOOP
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
-- DELETE: draft payments and their planned allocations only (the guards refuse anything else).
GRANT SELECT, INSERT, UPDATE, DELETE ON purchases_payments, purchases_payment_planned_allocations TO intuit_app;
GRANT SELECT, INSERT ON purchases_allocations TO intuit_app;
