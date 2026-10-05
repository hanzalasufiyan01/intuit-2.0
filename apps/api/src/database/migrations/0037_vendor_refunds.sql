-- 0037_vendor_refunds — Phase 4B-3: vendor refunds (ADR 0004 P4-24, P4-30, P4-33, P4-34, P4-42,
-- P4-51; 4B-3 decisions approved 2026-10-05).
--
-- * A vendor refund is a separate accounting transaction: money the vendor pays back from an open
--   vendor debit balance on AP — a recorded payment's unallocated prepayment, or a posted vendor
--   credit's unapplied amount. It never touches bills or bill allocations.
-- * RECORDED -> VOID; no draft, no approval. Recording takes the VR- number (P4-51), fixes the rate
--   (the table rate on the refund date, or a manual override with a mandatory reason, the table
--   rate kept) and posts through `purchases.refund_recorded`: Dr the refund account (bank or cash
--   only) at the refund rate, Cr AP for the source's historical base released, and the net
--   realized FX as one base-only line. fx_difference = base_amount (received) - base_released;
--   positive is a gain. Partial and multiple refunds are allowed up to the open balance.
-- * Void (re-authenticated, P4-42) reverses the journal through Purchases and restores the source.
-- * P4-33 backstop: a recorded payment cannot be voided while a recorded refund references it.

CREATE TABLE purchases_refunds (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                   text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'VOID')),
  number                   text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  vendor_id                uuid NOT NULL,
  source_type              text NOT NULL CHECK (source_type IN ('payment', 'vendor_credit')),
  payment_id               uuid,
  vendor_credit_id         uuid,
  refund_date              date NOT NULL,
  currency_code            char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount                   numeric(28, 4) NOT NULL CHECK (amount > 0),
  refund_account_id        uuid NOT NULL,
  -- The refund account differs from the Purchases default payment account.
  refund_account_overridden boolean NOT NULL,
  exchange_rate            numeric(28, 10) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_source     text NOT NULL CHECK (exchange_rate_source IN ('base', 'table', 'manual')),
  table_rate               numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  rate_override_reason     text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  -- Base received at the refund rate, base released from the source (its historical base), and
  -- the realized FX between them (positive = gain).
  base_amount              numeric(28, 4) NOT NULL CHECK (base_amount >= 0),
  base_released            numeric(28, 4) NOT NULL CHECK (base_released >= 0),
  fx_difference            numeric(28, 4) NOT NULL,
  reference                text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                     text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  journal_id               uuid NOT NULL,
  accounting_event_id      uuid NOT NULL,
  voided_by_user_id        uuid REFERENCES users (id),
  voided_at                timestamptz,
  void_reason              text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id          uuid,
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id       uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL,
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL,
  CONSTRAINT purchases_refunds_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_refunds_number_key UNIQUE (organization_id, number),
  CONSTRAINT purchases_refunds_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchases_refunds_payment_fkey FOREIGN KEY (payment_id, organization_id)
    REFERENCES purchases_payments (id, organization_id),
  CONSTRAINT purchases_refunds_vendor_credit_fkey FOREIGN KEY (vendor_credit_id, organization_id)
    REFERENCES purchases_vendor_credits (id, organization_id),
  CONSTRAINT purchases_refunds_account_fkey FOREIGN KEY (refund_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchases_refunds_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_refunds_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT purchases_refunds_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT purchases_refunds_source_consistency CHECK (
    (source_type = 'payment' AND payment_id IS NOT NULL AND vendor_credit_id IS NULL)
    OR (source_type = 'vendor_credit' AND vendor_credit_id IS NOT NULL AND payment_id IS NULL)),
  CONSTRAINT purchases_refunds_override_reason CHECK ((exchange_rate_source = 'manual') = (rate_override_reason IS NOT NULL)),
  CONSTRAINT purchases_refunds_fx_consistency CHECK (fx_difference = base_amount - base_released),
  CONSTRAINT purchases_refunds_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE INDEX purchases_refunds_payment_idx ON purchases_refunds (organization_id, payment_id, status)
  WHERE payment_id IS NOT NULL;
CREATE INDEX purchases_refunds_vendor_credit_idx ON purchases_refunds (organization_id, vendor_credit_id, status)
  WHERE vendor_credit_id IS NOT NULL;
CREATE INDEX purchases_refunds_vendor_idx ON purchases_refunds (organization_id, vendor_id, status);
CREATE INDEX purchases_refunds_list_idx ON purchases_refunds (organization_id, refund_date DESC, id);

-- Refunds: recorded refunds are immutable except the void (R35 parity); never deleted.
CREATE FUNCTION purchases_guard_refund() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds are voided, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void refund % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'RECORDED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'refund % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.vendor_id, NEW.source_type, NEW.payment_id,
      NEW.vendor_credit_id, NEW.refund_date, NEW.currency_code, NEW.amount, NEW.refund_account_id,
      NEW.refund_account_overridden, NEW.exchange_rate, NEW.exchange_rate_source, NEW.table_rate,
      NEW.rate_override_reason, NEW.base_amount, NEW.base_released, NEW.fx_difference,
      NEW.reference, NEW.memo, NEW.journal_id, NEW.accounting_event_id, NEW.created_by_user_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.vendor_id, OLD.source_type, OLD.payment_id,
      OLD.vendor_credit_id, OLD.refund_date, OLD.currency_code, OLD.amount, OLD.refund_account_id,
      OLD.refund_account_overridden, OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate,
      OLD.rate_override_reason, OLD.base_amount, OLD.base_released, OLD.fx_difference,
      OLD.reference, OLD.memo, OLD.journal_id, OLD.accounting_event_id, OLD.created_by_user_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'recorded refund % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_refunds_guard
  BEFORE UPDATE OR DELETE ON purchases_refunds
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_refund();

-- P4-33 backstop: refunds taken from a payment must be voided before the payment itself.
CREATE FUNCTION purchases_refuse_payment_void_with_refunds() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchases_refunds r
              WHERE r.organization_id = NEW.organization_id AND r.payment_id = NEW.id
                AND r.status = 'RECORDED') THEN
    RAISE EXCEPTION 'payment % has recorded refunds; void them before the payment', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_payments_refund_backstop
  BEFORE UPDATE OF status ON purchases_payments
  FOR EACH ROW WHEN (OLD.status = 'RECORDED' AND NEW.status = 'VOID')
  EXECUTE FUNCTION purchases_refuse_payment_void_with_refunds();

CREATE TRIGGER purchases_refunds_no_truncate
  BEFORE TRUNCATE ON purchases_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
ALTER TABLE purchases_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_refunds_tenant ON purchases_refunds FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON purchases_refunds FROM PUBLIC;
-- No DELETE: refunds are voided, never deleted.
GRANT SELECT, INSERT, UPDATE ON purchases_refunds TO intuit_app;
