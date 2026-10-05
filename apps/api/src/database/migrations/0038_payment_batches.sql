-- 0038_payment_batches — Phase 4B-4: batch "Pay bills" (ADR 0004 P4-32, P4-50; 4B-4 decisions D1-D9
-- approved 2026-10-05).
--
-- * A payment batch records, in one transaction under one idempotency key, one vendor payment per
--   vendor and currency for the selected posted bills (P4-32). The batch itself posts nothing:
--   each payment follows the 4B-2 path (its own accounting event, journal, PAY- number and source
--   link). The batch record is immutable; the state of its payments is read from the payments.
-- * No batch number (D9): a batch is identified by its id and payment date.
-- * purchases_payments.payment_batch_id links a payment to its batch. It is set once (normally at
--   insert, at the latest while the payment is a draft) and never changes; existing payments stay
--   NULL. A separate guard enforces this; the 0036 payment guard is unchanged.

CREATE TABLE purchases_payment_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  payment_date        date NOT NULL,
  -- P4-50 and D5: at most 100 vendors, 497 bills per payment and 2,000 bills per batch.
  payment_count       integer NOT NULL CHECK (payment_count BETWEEN 1 AND 2000),
  bill_count          integer NOT NULL CHECK (bill_count BETWEEN 1 AND 2000),
  -- Per currency: [{ "currencyCode", "amount", "payments" }] (transaction currency; base amounts
  -- are read from the payments).
  totals              jsonb NOT NULL CHECK (jsonb_typeof(totals) = 'array'),
  reference           text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT purchases_payment_batches_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchases_payment_batches_counts CHECK (payment_count <= bill_count)
);
CREATE INDEX purchases_payment_batches_list_idx
  ON purchases_payment_batches (organization_id, payment_date DESC, created_at DESC, id);

-- The batch record is immutable and never deleted.
CREATE TRIGGER purchases_payment_batches_no_update
  BEFORE UPDATE OR DELETE ON purchases_payment_batches
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER purchases_payment_batches_no_truncate
  BEFORE TRUNCATE ON purchases_payment_batches
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
ALTER TABLE purchases_payment_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_payment_batches_tenant ON purchases_payment_batches FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON purchases_payment_batches FROM PUBLIC;
GRANT SELECT, INSERT ON purchases_payment_batches TO intuit_app;

-- The payment's batch: organization-scoped and set once.
ALTER TABLE purchases_payments ADD COLUMN payment_batch_id uuid;
ALTER TABLE purchases_payments ADD CONSTRAINT purchases_payments_batch_fkey
  FOREIGN KEY (payment_batch_id, organization_id)
  REFERENCES purchases_payment_batches (id, organization_id);
CREATE INDEX purchases_payments_batch_idx ON purchases_payments (organization_id, payment_batch_id)
  WHERE payment_batch_id IS NOT NULL;

-- Set-once: a batch can be given only to a draft without one; once set it never changes.
CREATE FUNCTION purchases_guard_payment_batch_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payment_batch_id IS NOT NULL OR OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the batch of payment % is set once and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_payments_batch_link_guard
  BEFORE UPDATE OF payment_batch_id ON purchases_payments
  FOR EACH ROW WHEN (NEW.payment_batch_id IS DISTINCT FROM OLD.payment_batch_id)
  EXECUTE FUNCTION purchases_guard_payment_batch_link();
