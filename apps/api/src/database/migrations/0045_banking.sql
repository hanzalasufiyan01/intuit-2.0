-- 0045_banking — Banking: bank accounts, imported statement transactions, matching, bank entries,
-- transfers, reconciliation and rules (approved 2026-10-07: a separate module; CSV and OFX behind a
-- provider abstraction; bank reconciliation never changes a posted journal line; a bank transfer is
-- a proper accounting source transaction).
--
-- * A banking account binds a bank, cash or card account of the chart of accounts to the
--   statements imported for it. A statement transaction is an immutable fact from the bank (signed
--   from the account's side: positive is money in); duplicates are recognized by a fingerprint of
--   the line and, when the bank gives one, its own transaction id.
-- * Matching links one statement transaction to one journal line of the bank account. The link
--   lives in its own table and is never a flag on the journal line, so posted accounting is not
--   touched. Unmatching keeps the history (unmatched_at).
-- * A bank entry categorizes an unmatched transaction: it is an accounting source document that
--   posts Dr/Cr the bank account against a chosen account through the `banking.entry_posted`
--   accounting event, and is matched to its transaction at once. A transfer moves money between two
--   banking accounts and posts through `banking.transfer_posted`.
-- * A reconciliation compares the cleared (matched) transactions with the statement balance. It
--   records which transactions it covered; it never writes to the ledger. A completed
--   reconciliation can be reopened (the latest only); its items stay as history.
-- * Rules suggest a category account for an unmatched transaction.
-- * Numbering: BE- for bank entries and TR- for transfers, from a per-organization sequence.

CREATE TABLE banking_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('bank_entry', 'bank_transfer')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE banking_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES accounting_settings (organization_id),
  account_id              uuid NOT NULL,
  name                    text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  currency_code           char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  -- The statement balance before the first imported transaction: where reconciliation starts.
  opening_balance         numeric(28, 4) NOT NULL DEFAULT 0,
  opening_balance_date    date,
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id      uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL,
  updated_by_user_id      uuid REFERENCES users (id),
  updated_at              timestamptz NOT NULL,
  CONSTRAINT banking_accounts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_accounts_account_key UNIQUE (organization_id, account_id),
  CONSTRAINT banking_accounts_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE banking_statement_imports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  banking_account_id   uuid NOT NULL,
  source               text NOT NULL CHECK (source IN ('csv', 'ofx')),
  content_sha256       text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  period_start         date,
  period_end           date,
  transaction_count    integer NOT NULL CHECK (transaction_count >= 0),
  duplicate_count      integer NOT NULL CHECK (duplicate_count >= 0),
  imported_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  CONSTRAINT banking_statement_imports_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_statement_imports_account_fkey FOREIGN KEY (banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id)
);
CREATE INDEX banking_statement_imports_account_idx
  ON banking_statement_imports (organization_id, banking_account_id, created_at DESC);

CREATE TABLE banking_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  banking_account_id   uuid NOT NULL,
  import_id            uuid NOT NULL,
  txn_date             date NOT NULL,
  description          text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  reference            text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  -- Signed from the account's side: positive is money in.
  amount               numeric(28, 4) NOT NULL CHECK (amount <> 0),
  currency_code        char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  balance              numeric(28, 4),
  external_id          text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200),
  fingerprint          text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status               text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED', 'MATCHED', 'EXCLUDED')),
  excluded_reason      text CHECK (excluded_reason IS NULL OR length(btrim(excluded_reason)) BETWEEN 1 AND 500),
  excluded_by_user_id  uuid REFERENCES users (id),
  excluded_at          timestamptz,
  created_at           timestamptz NOT NULL,
  CONSTRAINT banking_transactions_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_transactions_fingerprint_key UNIQUE (banking_account_id, fingerprint),
  CONSTRAINT banking_transactions_account_fkey FOREIGN KEY (banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  CONSTRAINT banking_transactions_import_fkey FOREIGN KEY (import_id, organization_id)
    REFERENCES banking_statement_imports (id, organization_id),
  CONSTRAINT banking_transactions_excluded CHECK (
    (status = 'EXCLUDED') = (excluded_reason IS NOT NULL AND excluded_at IS NOT NULL))
);
CREATE UNIQUE INDEX banking_transactions_external_idx
  ON banking_transactions (banking_account_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX banking_transactions_list_idx
  ON banking_transactions (organization_id, banking_account_id, txn_date DESC, id);
CREATE INDEX banking_transactions_status_idx
  ON banking_transactions (organization_id, banking_account_id, status, txn_date);

CREATE TABLE banking_matches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  banking_transaction_id  uuid NOT NULL,
  journal_id              uuid NOT NULL,
  journal_line_id         uuid NOT NULL REFERENCES accounting_journal_lines (id),
  source                  text NOT NULL CHECK (source IN ('manual', 'entry', 'transfer')),
  matched_by_user_id      uuid NOT NULL REFERENCES users (id),
  matched_at              timestamptz NOT NULL,
  unmatched_by_user_id    uuid REFERENCES users (id),
  unmatched_at            timestamptz,
  CONSTRAINT banking_matches_transaction_fkey FOREIGN KEY (banking_transaction_id, organization_id)
    REFERENCES banking_transactions (id, organization_id),
  CONSTRAINT banking_matches_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT banking_matches_unmatched CHECK ((unmatched_at IS NULL) = (unmatched_by_user_id IS NULL))
);
-- One active match per transaction and per journal line.
CREATE UNIQUE INDEX banking_matches_transaction_idx
  ON banking_matches (banking_transaction_id) WHERE unmatched_at IS NULL;
CREATE UNIQUE INDEX banking_matches_line_idx
  ON banking_matches (journal_line_id) WHERE unmatched_at IS NULL;
CREATE INDEX banking_matches_org_idx ON banking_matches (organization_id, banking_transaction_id);

CREATE TABLE banking_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  number                  text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  banking_transaction_id  uuid NOT NULL,
  banking_account_id      uuid NOT NULL,
  entry_date              date NOT NULL,
  direction               text NOT NULL CHECK (direction IN ('in', 'out')),
  amount                  numeric(28, 4) NOT NULL CHECK (amount > 0),
  currency_code           char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  category_account_id     uuid NOT NULL,
  memo                    text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  dimension_value_ids     uuid[] NOT NULL DEFAULT '{}',
  exchange_rate           numeric(28, 10) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_source    text NOT NULL CHECK (exchange_rate_source IN ('base', 'table')),
  base_amount             numeric(28, 4) NOT NULL CHECK (base_amount > 0),
  status                  text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  journal_id              uuid NOT NULL,
  accounting_event_id     uuid NOT NULL,
  voided_by_user_id       uuid REFERENCES users (id),
  voided_at               timestamptz,
  void_reason             text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id         uuid,
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id      uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL,
  updated_by_user_id      uuid REFERENCES users (id),
  updated_at              timestamptz NOT NULL,
  CONSTRAINT banking_entries_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_entries_transaction_fkey FOREIGN KEY (banking_transaction_id, organization_id)
    REFERENCES banking_transactions (id, organization_id),
  CONSTRAINT banking_entries_account_fkey FOREIGN KEY (banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  CONSTRAINT banking_entries_category_fkey FOREIGN KEY (category_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT banking_entries_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT banking_entries_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT banking_entries_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT banking_entries_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE UNIQUE INDEX banking_entries_number_idx ON banking_entries (organization_id, number);
-- One live entry per statement transaction; a voided entry lets it be categorized again.
CREATE UNIQUE INDEX banking_entries_transaction_idx
  ON banking_entries (banking_transaction_id) WHERE status = 'POSTED';

CREATE TABLE banking_transfers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  number                     text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  transfer_date              date NOT NULL,
  from_banking_account_id    uuid NOT NULL,
  to_banking_account_id      uuid NOT NULL,
  from_currency_code         char(3) NOT NULL CHECK (from_currency_code ~ '^[A-Z]{3}$'),
  to_currency_code           char(3) NOT NULL CHECK (to_currency_code ~ '^[A-Z]{3}$'),
  from_amount                numeric(28, 4) NOT NULL CHECK (from_amount > 0),
  to_amount                  numeric(28, 4) NOT NULL CHECK (to_amount > 0),
  -- The journal currency and the rate used (the implied rate when the two amounts differ).
  journal_currency_code      char(3) NOT NULL CHECK (journal_currency_code ~ '^[A-Z]{3}$'),
  exchange_rate              numeric(28, 10) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_source       text NOT NULL CHECK (exchange_rate_source IN ('base', 'table', 'implied')),
  base_amount                numeric(28, 4) NOT NULL CHECK (base_amount > 0),
  memo                       text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  dimension_value_ids        uuid[] NOT NULL DEFAULT '{}',
  status                     text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  journal_id                 uuid NOT NULL,
  accounting_event_id        uuid NOT NULL,
  voided_by_user_id          uuid REFERENCES users (id),
  voided_at                  timestamptz,
  void_reason                text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id            uuid,
  version                    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id         uuid NOT NULL REFERENCES users (id),
  created_at                 timestamptz NOT NULL,
  updated_by_user_id         uuid REFERENCES users (id),
  updated_at                 timestamptz NOT NULL,
  CONSTRAINT banking_transfers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_transfers_distinct CHECK (from_banking_account_id <> to_banking_account_id),
  CONSTRAINT banking_transfers_from_fkey FOREIGN KEY (from_banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  CONSTRAINT banking_transfers_to_fkey FOREIGN KEY (to_banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  CONSTRAINT banking_transfers_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT banking_transfers_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT banking_transfers_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT banking_transfers_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE UNIQUE INDEX banking_transfers_number_idx ON banking_transfers (organization_id, number);
CREATE INDEX banking_transfers_list_idx ON banking_transfers (organization_id, transfer_date DESC, id);

CREATE TABLE banking_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  banking_account_id    uuid NOT NULL,
  status                text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'REOPENED')),
  statement_date        date NOT NULL,
  statement_balance     numeric(28, 4) NOT NULL,
  opening_balance       numeric(28, 4) NOT NULL,
  cleared_total         numeric(28, 4) NOT NULL,
  item_count            integer NOT NULL CHECK (item_count >= 0),
  completed_by_user_id  uuid NOT NULL REFERENCES users (id),
  completed_at          timestamptz NOT NULL,
  reopened_by_user_id   uuid REFERENCES users (id),
  reopened_at           timestamptz,
  reopen_reason         text CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 1 AND 500),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT banking_reconciliations_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_reconciliations_account_fkey FOREIGN KEY (banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  -- A reconciliation only completes when the statement agrees with the cleared items.
  CONSTRAINT banking_reconciliations_balanced CHECK (statement_balance = opening_balance + cleared_total),
  CONSTRAINT banking_reconciliations_reopen CHECK (
    (status = 'REOPENED') = (reopened_at IS NOT NULL AND reopen_reason IS NOT NULL
                             AND reopened_by_user_id IS NOT NULL))
);
CREATE INDEX banking_reconciliations_account_idx
  ON banking_reconciliations (organization_id, banking_account_id, statement_date DESC);

CREATE TABLE banking_reconciliation_items (
  organization_id         uuid NOT NULL,
  reconciliation_id       uuid NOT NULL,
  banking_transaction_id  uuid NOT NULL,
  amount                  numeric(28, 4) NOT NULL,
  -- False once the reconciliation is reopened: the row stays as history.
  counted                 boolean NOT NULL DEFAULT true,
  PRIMARY KEY (reconciliation_id, banking_transaction_id),
  CONSTRAINT banking_reconciliation_items_reconciliation_fkey FOREIGN KEY (reconciliation_id, organization_id)
    REFERENCES banking_reconciliations (id, organization_id),
  CONSTRAINT banking_reconciliation_items_transaction_fkey FOREIGN KEY (banking_transaction_id, organization_id)
    REFERENCES banking_transactions (id, organization_id)
);
-- A transaction is counted in at most one reconciliation.
CREATE UNIQUE INDEX banking_reconciliation_items_counted_idx
  ON banking_reconciliation_items (banking_transaction_id) WHERE counted;

CREATE TABLE banking_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  banking_account_id      uuid,
  name                    text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  priority                integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  direction               text NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  description_contains    text CHECK (description_contains IS NULL OR length(btrim(description_contains)) BETWEEN 1 AND 200),
  min_amount              numeric(28, 4) CHECK (min_amount IS NULL OR min_amount >= 0),
  max_amount              numeric(28, 4) CHECK (max_amount IS NULL OR max_amount >= 0),
  category_account_id     uuid NOT NULL,
  memo                    text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id      uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL,
  updated_by_user_id      uuid REFERENCES users (id),
  updated_at              timestamptz NOT NULL,
  CONSTRAINT banking_rules_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT banking_rules_account_fkey FOREIGN KEY (banking_account_id, organization_id)
    REFERENCES banking_accounts (id, organization_id),
  CONSTRAINT banking_rules_category_fkey FOREIGN KEY (category_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT banking_rules_amount_range CHECK (min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount),
  CONSTRAINT banking_rules_has_condition CHECK (
    description_contains IS NOT NULL OR min_amount IS NOT NULL OR max_amount IS NOT NULL OR direction <> 'any')
);
CREATE INDEX banking_rules_list_idx ON banking_rules (organization_id, status, priority, id);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- A statement transaction is a fact from the bank: only its matching status changes.
CREATE FUNCTION banking_guard_transaction() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank transactions are never deleted (transaction %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.banking_account_id, NEW.import_id, NEW.txn_date,
      NEW.description, NEW.reference, NEW.amount, NEW.currency_code, NEW.balance, NEW.external_id,
      NEW.fingerprint, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.banking_account_id, OLD.import_id, OLD.txn_date,
      OLD.description, OLD.reference, OLD.amount, OLD.currency_code, OLD.balance, OLD.external_id,
      OLD.fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'bank transaction % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Excluding is possible only for an unmatched transaction; restoring returns it to unmatched.
  IF NEW.status = 'EXCLUDED' AND OLD.status = 'MATCHED' THEN
    RAISE EXCEPTION 'matched bank transaction % cannot be excluded', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_transactions_guard
  BEFORE UPDATE OR DELETE ON banking_transactions
  FOR EACH ROW EXECUTE FUNCTION banking_guard_transaction();

-- A match is history once made: only the unmatch columns are set, once, and never for a
-- transaction that a reconciliation counts.
CREATE FUNCTION banking_guard_match() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank matches are never deleted (match %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.banking_transaction_id, NEW.journal_id, NEW.journal_line_id,
      NEW.source, NEW.matched_by_user_id, NEW.matched_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.banking_transaction_id, OLD.journal_id, OLD.journal_line_id,
      OLD.source, OLD.matched_by_user_id, OLD.matched_at) THEN
    RAISE EXCEPTION 'bank match % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.unmatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'bank match % is already undone', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.unmatched_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM banking_reconciliation_items i
        WHERE i.banking_transaction_id = OLD.banking_transaction_id AND i.counted) THEN
    RAISE EXCEPTION 'bank transaction % is reconciled; reopen the reconciliation first',
      OLD.banking_transaction_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_matches_guard
  BEFORE UPDATE OR DELETE ON banking_matches
  FOR EACH ROW EXECUTE FUNCTION banking_guard_match();

-- A matched line must be a line of the banking account's own chart account, with the
-- transaction's amount (the account's currency; the base amount for a base-currency account).
CREATE FUNCTION banking_guard_match_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_txn     record;
  v_line    record;
  v_base    char(3);
  v_signed  numeric;
BEGIN
  SELECT t.amount, t.status, a.account_id, a.currency_code INTO v_txn
    FROM banking_transactions t
    JOIN banking_accounts a ON a.id = t.banking_account_id AND a.organization_id = t.organization_id
   WHERE t.id = NEW.banking_transaction_id AND t.organization_id = NEW.organization_id;
  SELECT l.account_id, l.journal_id, l.organization_id,
         coalesce(l.debit, 0) - coalesce(l.credit, 0) AS own,
         coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0) AS base,
         j.status AS journal_status
    INTO v_line
    FROM accounting_journal_lines l
    JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
   WHERE l.id = NEW.journal_line_id;
  SELECT base_currency INTO v_base FROM accounting_settings WHERE organization_id = NEW.organization_id;
  IF v_txn IS NULL OR v_line IS NULL OR v_line.organization_id <> NEW.organization_id
     OR v_line.journal_id <> NEW.journal_id THEN
    RAISE EXCEPTION 'the match does not belong to this organization' USING ERRCODE = 'check_violation';
  END IF;
  IF v_line.account_id IS DISTINCT FROM v_txn.account_id THEN
    RAISE EXCEPTION 'the journal line is not on the bank account' USING ERRCODE = 'check_violation';
  END IF;
  IF v_line.journal_status NOT IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'only a posted journal line can be matched' USING ERRCODE = 'check_violation';
  END IF;
  v_signed := CASE WHEN v_txn.currency_code = v_base THEN v_line.base ELSE v_line.own END;
  IF v_signed <> v_txn.amount THEN
    RAISE EXCEPTION 'the journal line amount differs from the bank transaction' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_matches_insert_guard
  BEFORE INSERT ON banking_matches
  FOR EACH ROW EXECUTE FUNCTION banking_guard_match_insert();

-- Posted bank entries and transfers change only by their void.
CREATE FUNCTION banking_guard_posted_document() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted (%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void % % is immutable', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'VOID' AND to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by_user_id'
       IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by_user_id' THEN
    RAISE EXCEPTION 'posted % % is immutable', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_entries_guard
  BEFORE UPDATE OR DELETE ON banking_entries
  FOR EACH ROW EXECUTE FUNCTION banking_guard_posted_document();
CREATE TRIGGER banking_transfers_guard
  BEFORE UPDATE OR DELETE ON banking_transfers
  FOR EACH ROW EXECUTE FUNCTION banking_guard_posted_document();

-- A reconciliation is immutable once completed; only the reopen sets its columns, once.
CREATE FUNCTION banking_guard_reconciliation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliations are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REOPENED' THEN
    RAISE EXCEPTION 'reopened reconciliation % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.banking_account_id, NEW.statement_date, NEW.statement_balance,
      NEW.opening_balance, NEW.cleared_total, NEW.item_count, NEW.completed_by_user_id, NEW.completed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.banking_account_id, OLD.statement_date, OLD.statement_balance,
      OLD.opening_balance, OLD.cleared_total, OLD.item_count, OLD.completed_by_user_id, OLD.completed_at) THEN
    RAISE EXCEPTION 'completed reconciliation % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_reconciliations_guard
  BEFORE UPDATE OR DELETE ON banking_reconciliations
  FOR EACH ROW EXECUTE FUNCTION banking_guard_reconciliation();

-- Items are written once; only `counted` goes false, when the reconciliation is reopened.
CREATE FUNCTION banking_guard_reconciliation_item() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation items are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.reconciliation_id, NEW.banking_transaction_id, NEW.amount)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.reconciliation_id, OLD.banking_transaction_id, OLD.amount)
     OR (NEW.counted AND NOT OLD.counted) THEN
    RAISE EXCEPTION 'reconciliation items cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banking_reconciliation_items_guard
  BEFORE UPDATE OR DELETE ON banking_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION banking_guard_reconciliation_item();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'banking_number_sequences', 'banking_accounts', 'banking_statement_imports',
    'banking_transactions', 'banking_matches', 'banking_entries', 'banking_transfers',
    'banking_reconciliations', 'banking_reconciliation_items', 'banking_rules'
  ] LOOP
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

-- ---------------------------------------------------------------------------
-- Permissions and the backfill for existing organizations
-- ---------------------------------------------------------------------------
-- Owner and Administrator receive all nine Banking permissions; Member receives the view
-- permission only. Additive: nothing is removed, custom roles are untouched, ON CONFLICT DO
-- NOTHING makes it idempotent, and every changed role gets an append-only audit event.

INSERT INTO permissions (key, module, description) VALUES
  ('banking.accounts.manage', 'banking', 'Create, edit and archive bank accounts'),
  ('banking.transactions.view', 'banking', 'View bank accounts, statement transactions, transfers and reconciliations'),
  ('banking.transactions.import', 'banking', 'Import bank statements (CSV and OFX)'),
  ('banking.transactions.match', 'banking', 'Match, unmatch and exclude statement transactions'),
  ('banking.transactions.categorize', 'banking', 'Categorize statement transactions, posting bank entries'),
  ('banking.transfers.create', 'banking', 'Record transfers between bank accounts'),
  ('banking.transfers.void', 'banking', 'Void bank entries and transfers'),
  ('banking.reconcile', 'banking', 'Complete and reopen bank reconciliations'),
  ('banking.rules.manage', 'banking', 'Manage bank categorization rules')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE banking_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO banking_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('banking.accounts.manage'), ('banking.transactions.view'), ('banking.transactions.import'),
  ('banking.transactions.match'), ('banking.transactions.categorize'),
  ('banking.transfers.create'), ('banking.transfers.void'), ('banking.reconcile'),
  ('banking.rules.manage')
) AS p (key);
INSERT INTO banking_backfill_grants (template_key, permission_key) VALUES
  ('member', 'banking.transactions.view');

CREATE TEMPORARY TABLE banking_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN banking_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO banking_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0045_banking',
       jsonb_build_object(
         'reason', 'Banking permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM banking_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
