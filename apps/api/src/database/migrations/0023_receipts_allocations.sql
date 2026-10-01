-- 0023_receipts_allocations — Phase 3B steps 8–11: receipts, allocations, customer credit and
-- realized FX. Decisions 10, 11, 36–40, 42, 52 (R35); Phase 3B D2, D3, E1.
--
-- * A receipt has one currency (Decision 36). It is recorded and posted at once: Dr the deposit
--   account at the receipt rate; Cr AR per invoice at that invoice's historical base; Cr AR for any
--   excess, which becomes customer credit in the receipt currency (Decision 38); the difference
--   between receipt-rate and historical base is realized FX (Decision 10).
-- * The rate is the table rate on the receipt date unless overridden with a mandatory reason; the
--   table rate is retained next to it (D2). The deposit account defaults from the Sales settings and
--   may be overridden within the bank/cash and currency rules (Decision 42, D3).
-- * Allocations are append-only: applying credit adds rows, and a void adds reversing rows
--   (Decisions 39, 40). Receipts are voided, never deleted or edited (R35).

CREATE TABLE sales_receipts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                    text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'VOID')),
  number                    text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  customer_id               uuid NOT NULL,
  receipt_date              date NOT NULL,
  currency_code             char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount                    numeric(28, 4) NOT NULL CHECK (amount > 0),
  exchange_rate             numeric(28, 10) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_source      text NOT NULL CHECK (exchange_rate_source IN ('base', 'table', 'manual')),
  -- D2: the table rate on the receipt date, kept when the rate was overridden (NULL if none).
  table_rate                numeric(28, 10) CHECK (table_rate IS NULL OR table_rate > 0),
  rate_override_reason      text CHECK (rate_override_reason IS NULL OR length(btrim(rate_override_reason)) BETWEEN 1 AND 500),
  deposit_account_id        uuid NOT NULL,
  -- D3: the deposit account differs from the Sales settings default.
  deposit_account_overridden boolean NOT NULL DEFAULT false,
  -- Base value of the receipt: the sum of its parts at the receipt rate.
  base_amount               numeric(28, 4) NOT NULL CHECK (base_amount >= 0),
  -- Customer credit still to apply (receipt currency) and the base it carries on AR.
  amount_unallocated        numeric(28, 4) NOT NULL CHECK (amount_unallocated >= 0),
  base_unallocated          numeric(28, 4) NOT NULL CHECK (base_unallocated >= 0),
  reference                 text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                      text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  journal_id                uuid NOT NULL,
  accounting_event_id       uuid NOT NULL,
  voided_by_user_id         uuid REFERENCES users (id),
  voided_at                 timestamptz,
  void_reason               text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id           uuid,
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id        uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL,
  updated_by_user_id        uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL,
  CONSTRAINT sales_receipts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_receipts_number_key UNIQUE (organization_id, number),
  CONSTRAINT sales_receipts_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_receipts_deposit_fkey FOREIGN KEY (deposit_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT sales_receipts_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_receipts_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT sales_receipts_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT sales_receipts_override_reason CHECK ((exchange_rate_source = 'manual') = (rate_override_reason IS NOT NULL)),
  CONSTRAINT sales_receipts_unallocated_range CHECK (amount_unallocated <= amount),
  CONSTRAINT sales_receipts_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL
                              AND amount_unallocated = 0 AND base_unallocated = 0)))
);
CREATE INDEX sales_receipts_customer_idx ON sales_receipts (organization_id, customer_id, status);
CREATE INDEX sales_receipts_list_idx ON sales_receipts (organization_id, receipt_date DESC, id);

CREATE TABLE sales_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  -- Where the money or credit comes from.
  source_type            text NOT NULL CHECK (source_type IN ('receipt', 'credit_note')),
  receipt_id             uuid,
  credit_note_id         uuid,
  invoice_id             uuid NOT NULL,
  -- 'receipt': allocated when the receipt was recorded; 'credit': customer credit applied later.
  mode                   text NOT NULL CHECK (mode IN ('receipt', 'credit')),
  allocation_date        date NOT NULL,
  currency_code          char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- Positive when applied; a reversing row carries the negated amounts.
  amount                 numeric(28, 4) NOT NULL CHECK (amount <> 0),
  -- Historical base relieved on the invoice, and the base value the source gave up.
  base_relieved          numeric(28, 4) NOT NULL,
  source_base            numeric(28, 4) NOT NULL,
  -- Realized FX: source base minus relieved base (positive = gain).
  fx_difference          numeric(28, 4) NOT NULL,
  reverses_allocation_id uuid,
  journal_id             uuid NOT NULL,
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  CONSTRAINT sales_allocations_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_allocations_source_consistency CHECK (
    (source_type = 'receipt' AND receipt_id IS NOT NULL AND credit_note_id IS NULL)
    OR (source_type = 'credit_note' AND credit_note_id IS NOT NULL AND receipt_id IS NULL)),
  CONSTRAINT sales_allocations_mode_consistency CHECK (source_type = 'receipt' OR mode = 'credit'),
  CONSTRAINT sales_allocations_fx_consistency CHECK (fx_difference = source_base - base_relieved),
  CONSTRAINT sales_allocations_sign_consistency CHECK (
    (reverses_allocation_id IS NULL AND amount > 0) OR (reverses_allocation_id IS NOT NULL AND amount < 0)),
  CONSTRAINT sales_allocations_receipt_fkey FOREIGN KEY (receipt_id, organization_id)
    REFERENCES sales_receipts (id, organization_id),
  CONSTRAINT sales_allocations_credit_note_fkey FOREIGN KEY (credit_note_id, organization_id)
    REFERENCES sales_credit_notes (id, organization_id),
  CONSTRAINT sales_allocations_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id),
  CONSTRAINT sales_allocations_reverses_fkey FOREIGN KEY (reverses_allocation_id, organization_id)
    REFERENCES sales_allocations (id, organization_id),
  CONSTRAINT sales_allocations_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
-- An allocation is reversed at most once.
CREATE UNIQUE INDEX sales_allocations_reversal_idx ON sales_allocations (reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;
CREATE INDEX sales_allocations_invoice_idx ON sales_allocations (organization_id, invoice_id);
CREATE INDEX sales_allocations_receipt_idx ON sales_allocations (organization_id, receipt_id)
  WHERE receipt_id IS NOT NULL;
CREATE INDEX sales_allocations_credit_note_idx ON sales_allocations (organization_id, credit_note_id)
  WHERE credit_note_id IS NOT NULL;

-- Receipts: immutable except the unallocated credit and the void (R35, Decision 40).
CREATE FUNCTION sales_guard_receipt() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts are voided, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.customer_id, NEW.receipt_date, NEW.currency_code,
      NEW.amount, NEW.exchange_rate, NEW.exchange_rate_source, NEW.table_rate,
      NEW.rate_override_reason, NEW.deposit_account_id, NEW.deposit_account_overridden,
      NEW.base_amount, NEW.reference, NEW.memo, NEW.journal_id, NEW.accounting_event_id,
      NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.customer_id, OLD.receipt_date, OLD.currency_code,
      OLD.amount, OLD.exchange_rate, OLD.exchange_rate_source, OLD.table_rate,
      OLD.rate_override_reason, OLD.deposit_account_id, OLD.deposit_account_overridden,
      OLD.base_amount, OLD.reference, OLD.memo, OLD.journal_id, OLD.accounting_event_id,
      OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'recorded receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'RECORDED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'receipt % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_receipts_guard
  BEFORE UPDATE OR DELETE ON sales_receipts
  FOR EACH ROW EXECUTE FUNCTION sales_guard_receipt();

CREATE TRIGGER sales_allocations_no_update
  BEFORE UPDATE OR DELETE ON sales_allocations
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_receipts', 'sales_allocations'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON sales_receipts TO intuit_app;
GRANT SELECT, INSERT ON sales_allocations TO intuit_app;
