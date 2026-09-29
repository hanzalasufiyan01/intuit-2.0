-- Intuit 2.0 — Phase 3A, S1: FX journal lines, source references and the replaced guards.
--
-- Decisions 10, 11, 12, 71 and C3 (ADR 0002 Amendment 1, A1.1–A1.3 and A1.7):
--   * Journal lines have a kind. 'normal' lines keep the Phase 2 rules (a transaction amount
--     and a base amount on the same side). 'base_only' lines have no transaction amount and
--     exactly one positive base amount. They are restricted to approved FX/revaluation system
--     journals (source 'system' with an allowlisted source_type).
--   * Posting requires base debits = base credits across all lines and transaction debits =
--     transaction credits across normal lines.
--   * Account-currency rule: a normal line posts to an account whose currency is the journal
--     currency or the base currency; a base_only line posts to a base-currency account or to a
--     foreign-currency monetary account (Decision 71).
--   * Control accounts (C3) are rejected in manual journals.
--   * Journals carry source_module/source_type/source_id, set at creation and never changed.
--     Existing journals keep NULL sources; existing lines become 'normal'.

-- ---------------------------------------------------------------------------
-- Journal entries: system source and source references
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_journal_entries DROP CONSTRAINT accounting_journal_entries_source_check;
ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_source_check
  CHECK (source IN ('manual', 'reversal', 'event', 'system'));

ALTER TABLE accounting_journal_entries
  ADD COLUMN source_module text CHECK (source_module ~ '^[a-z][a-z0-9_-]*$'),
  ADD COLUMN source_type   text CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  ADD COLUMN source_id     uuid;
ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_source_ref_complete CHECK (
  (source_module IS NULL AND source_type IS NULL AND source_id IS NULL)
  OR (source_module IS NOT NULL AND source_type IS NOT NULL AND source_id IS NOT NULL)
);
CREATE INDEX accounting_journal_entries_source_ref_idx
  ON accounting_journal_entries (organization_id, source_module, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- A journal made only of base_only lines has no transaction-currency total.
ALTER TABLE accounting_journal_entries DROP CONSTRAINT accounting_journal_entries_posted_complete;
ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_posted_complete CHECK (
  status NOT IN ('POSTED', 'REVERSED') OR (
    entry_date IS NOT NULL AND period_id IS NOT NULL AND exchange_rate IS NOT NULL
    AND base_currency IS NOT NULL AND total_debit = total_credit AND total_debit >= 0
    AND total_base_debit = total_base_credit AND total_base_debit > 0
  )
);

-- ---------------------------------------------------------------------------
-- Journal lines: line kind
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_journal_lines
  ADD COLUMN line_kind text NOT NULL DEFAULT 'normal' CHECK (line_kind IN ('normal', 'base_only'));
ALTER TABLE accounting_journal_lines ADD CONSTRAINT accounting_journal_lines_base_only_amounts
  CHECK (line_kind = 'normal' OR (debit IS NULL AND credit IS NULL));

-- ---------------------------------------------------------------------------
-- Replaced posting guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION accounting_guard_journal_entry() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_period record;
  v_lines record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'journal % is %, only drafts may be deleted', OLD.id, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'journals must be created as drafts' USING ERRCODE = 'check_violation';
  END IF;

  -- Source and source references are set at creation and never change (Decision 12).
  IF TG_OP = 'UPDATE' AND (NEW.source, NEW.source_module, NEW.source_type, NEW.source_id)
       IS DISTINCT FROM (OLD.source, OLD.source_module, OLD.source_type, OLD.source_id) THEN
    RAISE EXCEPTION 'the source of journal % is immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('POSTED', 'REVERSED') THEN
    IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
            AND NEW.reversed_at IS NOT NULL AND NEW.reversed_by_user_id IS NOT NULL
            AND (to_jsonb(NEW) - ARRAY['status', 'reversed_at', 'reversed_by_user_id', 'updated_at'])
              = (to_jsonb(OLD) - ARRAY['status', 'reversed_at', 'reversed_by_user_id', 'updated_at'])) THEN
      RAISE EXCEPTION 'posted journal % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'only posted journals can be reversed' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'POSTED' THEN
    SELECT status, start_date, end_date INTO v_period
      FROM accounting_periods
      WHERE id = NEW.period_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR v_period.status <> 'OPEN'
       OR NEW.entry_date NOT BETWEEN v_period.start_date AND v_period.end_date THEN
      RAISE EXCEPTION 'journal % must be dated inside an open accounting period', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) AS n,
           count(*) FILTER (WHERE l.account_id IS NULL
                             OR (l.line_kind = 'normal' AND (
                                   (l.debit IS NULL) = (l.credit IS NULL)
                                   OR (l.base_debit IS NULL) = (l.base_credit IS NULL)
                                   OR (l.debit IS NULL) <> (l.base_debit IS NULL)))
                             OR (l.line_kind = 'base_only' AND (
                                   l.debit IS NOT NULL OR l.credit IS NOT NULL
                                   OR (l.base_debit IS NULL) = (l.base_credit IS NULL)))) AS invalid,
           count(*) FILTER (WHERE l.line_kind = 'base_only') AS base_only,
           count(*) FILTER (WHERE (l.line_kind = 'normal'
                                   AND a.currency_code NOT IN (NEW.currency, NEW.base_currency))
                               OR (l.line_kind = 'base_only'
                                   AND a.currency_code <> NEW.base_currency AND NOT a.is_monetary)) AS wrong_currency,
           count(*) FILTER (WHERE NEW.source = 'manual' AND a.is_control_account) AS control,
           coalesce(sum(l.debit), 0) AS debit, coalesce(sum(l.credit), 0) AS credit,
           coalesce(sum(l.base_debit), 0) AS base_debit, coalesce(sum(l.base_credit), 0) AS base_credit
      INTO v_lines
      FROM accounting_journal_lines l
      LEFT JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
      WHERE l.journal_id = NEW.id AND l.organization_id = NEW.organization_id;
    IF v_lines.n < 2 OR v_lines.invalid > 0
       OR v_lines.debit <> v_lines.credit OR v_lines.base_debit <> v_lines.base_credit
       OR v_lines.debit <> NEW.total_debit OR v_lines.base_debit <> NEW.total_base_debit THEN
      RAISE EXCEPTION 'journal % is not a valid balanced double entry', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_lines.base_only > 0 AND NOT (NEW.source = 'system'
         AND NEW.source_type IN ('realized_fx', 'revaluation', 'revaluation_reversal')) THEN
      RAISE EXCEPTION 'journal % may not contain base-only lines', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_lines.wrong_currency > 0 THEN
      RAISE EXCEPTION 'journal % posts to an account in another currency', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_lines.control > 0 THEN
      RAISE EXCEPTION 'manual journal % may not post to a control account', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
