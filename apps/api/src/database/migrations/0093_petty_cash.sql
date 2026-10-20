-- 0093_petty_cash — petty cash funds and counts (master specification section 13, "Petty cash").
-- REVERSIBLE DEFAULTS chosen by the implementer and the owner's answer of 2026-10-19 (ADR 0015).
--
-- A FUND is a named cash float held by a custodian: it points at a cash account of the ledger (a
-- base-currency ASSET account with subtype CASH) and records the float amount that should be on
-- hand. Spending from the fund and topping it up are ordinary ledger entries (expenses paid from
-- that account, bank transfers); this feature does not post them.
-- A COUNT compares the cash actually counted with the ledger balance of the fund's account on the
-- count date. When they differ, the difference is posted through the accounting event
-- 'petty_cash.count_posted' to the CASH OVER/SHORT account the organization chose in the settings
-- (Dr fund account / Cr over-short when cash is over; the reverse when short). A count is final.

CREATE TABLE petty_cash_settings (
  organization_id          uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  over_short_account_id    uuid,
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL,
  CONSTRAINT petty_cash_settings_account_fkey FOREIGN KEY (over_short_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE petty_cash_funds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  name_key            text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  account_id          uuid NOT NULL,
  custodian_name      text NOT NULL CHECK (length(btrim(custodian_name)) BETWEEN 1 AND 100),
  float_amount        numeric(28, 4) NOT NULL CHECK (float_amount >= 0),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT petty_cash_funds_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT petty_cash_funds_name_key UNIQUE (organization_id, name_key),
  CONSTRAINT petty_cash_funds_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);
-- One fund per ledger account: two funds must not share a cash account.
CREATE UNIQUE INDEX petty_cash_funds_account_idx ON petty_cash_funds (organization_id, account_id)
  WHERE status = 'ACTIVE';

CREATE TABLE petty_cash_count_sequences (
  organization_id  uuid PRIMARY KEY REFERENCES organizations (id),
  prefix           text NOT NULL DEFAULT 'PCC-' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);

CREATE TABLE petty_cash_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  fund_id             uuid NOT NULL,
  count_date          date NOT NULL,
  counted_amount      numeric(28, 4) NOT NULL CHECK (counted_amount >= 0),
  book_balance        numeric(28, 4) NOT NULL,
  difference          numeric(28, 4) NOT NULL,
  journal_id          uuid,
  memo                text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT petty_cash_counts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT petty_cash_counts_fund_fkey FOREIGN KEY (fund_id, organization_id)
    REFERENCES petty_cash_funds (id, organization_id),
  CONSTRAINT petty_cash_counts_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT petty_cash_counts_difference CHECK (difference = counted_amount - book_balance),
  CONSTRAINT petty_cash_counts_journal_when_different CHECK ((difference = 0) = (journal_id IS NULL))
);
CREATE UNIQUE INDEX petty_cash_counts_number_idx ON petty_cash_counts (organization_id, number);
CREATE INDEX petty_cash_counts_fund_idx ON petty_cash_counts (organization_id, fund_id, count_date DESC);

-- Counts are final.
CREATE TRIGGER petty_cash_counts_immutable BEFORE UPDATE OR DELETE ON petty_cash_counts
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- A fund's account never changes (a different account is a different fund).
CREATE FUNCTION petty_cash_fund_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'petty cash funds are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.account_id) IS DISTINCT FROM (OLD.organization_id, OLD.account_id) THEN
    RAISE EXCEPTION 'the account of petty cash fund % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER petty_cash_funds_guard BEFORE UPDATE OR DELETE ON petty_cash_funds
  FOR EACH ROW EXECUTE FUNCTION petty_cash_fund_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['petty_cash_settings', 'petty_cash_funds', 'petty_cash_count_sequences', 'petty_cash_counts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE ON petty_cash_settings, petty_cash_funds, petty_cash_count_sequences TO intuit_app;
GRANT SELECT, INSERT ON petty_cash_counts TO intuit_app;
