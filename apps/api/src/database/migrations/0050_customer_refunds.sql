-- 0050_customer_refunds — customer refunds (priority list of 2026-10-07; mirrors 0037 vendor refunds).
--
-- * A customer refund is a separate accounting transaction: money paid back to the customer from
--   an open customer credit balance on AR — a recorded receipt's unallocated amount, or an issued
--   credit note's unapplied amount. It never touches invoices or allocations.
-- * RECORDED -> VOID; no draft, no approval. Recording takes the RF- number (own lazy sequence),
--   fixes the rate (the table rate on the refund date, or a manual override with a mandatory
--   reason, the table rate kept) and posts through `sales.refund_recorded`: Dr AR for the
--   source's historical base released, Cr the refund account (bank or cash only) at the refund
--   rate, and the net realized FX as one base-only line. fx_difference = base_released -
--   base_amount (base paid); positive is a gain (the liability released exceeded the cash paid).
--   Partial and multiple refunds are allowed up to the open balance.
-- * Void (re-authenticated) reverses the journal through Sales and restores the source.
-- * Backstop: a recorded receipt cannot be voided while a recorded refund references it.

CREATE TABLE sales_refund_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('refund')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE sales_refunds (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                   text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'VOID')),
  number                   text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  customer_id              uuid NOT NULL,
  source_type              text NOT NULL CHECK (source_type IN ('receipt', 'credit_note')),
  receipt_id               uuid,
  credit_note_id           uuid,
  refund_date              date NOT NULL,
  currency_code            char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount                   numeric(28, 4) NOT NULL CHECK (amount > 0),
  refund_account_id        uuid NOT NULL,
  refund_account_overridden boolean NOT NULL,
  exchange_rate            numeric(28, 10) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_source     text NOT NULL CHECK (exchange_rate_source IN ('base', 'table', 'manual')),
  table_rate               numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  rate_override_reason     text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  -- Base paid out at the refund rate, base released from the source (its historical base), and
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
  CONSTRAINT sales_refunds_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_refunds_number_key UNIQUE (organization_id, number),
  CONSTRAINT sales_refunds_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_refunds_receipt_fkey FOREIGN KEY (receipt_id, organization_id)
    REFERENCES sales_receipts (id, organization_id),
  CONSTRAINT sales_refunds_credit_note_fkey FOREIGN KEY (credit_note_id, organization_id)
    REFERENCES sales_credit_notes (id, organization_id),
  CONSTRAINT sales_refunds_account_fkey FOREIGN KEY (refund_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_refunds_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_refunds_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT sales_refunds_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_refunds_source_consistency CHECK (
    (source_type = 'receipt' AND receipt_id IS NOT NULL AND credit_note_id IS NULL)
    OR (source_type = 'credit_note' AND credit_note_id IS NOT NULL AND receipt_id IS NULL)),
  CONSTRAINT sales_refunds_override_reason CHECK ((exchange_rate_source = 'manual') = (rate_override_reason IS NOT NULL)),
  CONSTRAINT sales_refunds_fx_consistency CHECK (fx_difference = base_released - base_amount),
  CONSTRAINT sales_refunds_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE INDEX sales_refunds_receipt_idx ON sales_refunds (organization_id, receipt_id, status)
  WHERE receipt_id IS NOT NULL;
CREATE INDEX sales_refunds_credit_note_idx ON sales_refunds (organization_id, credit_note_id, status)
  WHERE credit_note_id IS NOT NULL;
CREATE INDEX sales_refunds_customer_idx ON sales_refunds (organization_id, customer_id, status);
CREATE INDEX sales_refunds_list_idx ON sales_refunds (organization_id, refund_date DESC, id);

-- Recorded refunds are immutable except the void; never deleted.
CREATE FUNCTION sales_guard_refund() RETURNS trigger
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
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.customer_id, NEW.source_type, NEW.receipt_id,
      NEW.credit_note_id, NEW.refund_date, NEW.currency_code, NEW.amount, NEW.refund_account_id,
      NEW.refund_account_overridden, NEW.exchange_rate, NEW.exchange_rate_source, NEW.table_rate,
      NEW.rate_override_reason, NEW.base_amount, NEW.base_released, NEW.fx_difference,
      NEW.reference, NEW.memo, NEW.journal_id, NEW.accounting_event_id, NEW.created_by_user_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.customer_id, OLD.source_type, OLD.receipt_id,
      OLD.credit_note_id, OLD.refund_date, OLD.currency_code, OLD.amount, OLD.refund_account_id,
      OLD.refund_account_overridden, OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate,
      OLD.rate_override_reason, OLD.base_amount, OLD.base_released, OLD.fx_difference,
      OLD.reference, OLD.memo, OLD.journal_id, OLD.accounting_event_id, OLD.created_by_user_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'recorded refund % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_refunds_guard
  BEFORE UPDATE OR DELETE ON sales_refunds
  FOR EACH ROW EXECUTE FUNCTION sales_guard_refund();

-- Backstop: refunds taken from a receipt must be voided before the receipt itself.
CREATE FUNCTION sales_refuse_receipt_void_with_refunds() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM sales_refunds r
              WHERE r.organization_id = NEW.organization_id AND r.receipt_id = NEW.id
                AND r.status = 'RECORDED') THEN
    RAISE EXCEPTION 'receipt % has recorded refunds; void them before the receipt', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_receipts_refund_backstop
  BEFORE UPDATE OF status ON sales_receipts
  FOR EACH ROW WHEN (OLD.status = 'RECORDED' AND NEW.status = 'VOID')
  EXECUTE FUNCTION sales_refuse_receipt_void_with_refunds();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_refund_number_sequences', 'sales_refunds'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO intuit_app', t);
  END LOOP;
END;
$$;
