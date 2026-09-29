-- 0017_revaluation_support — Phase 3A S9: foreign-currency revaluation support.
-- Decisions 9, 10, 11, 53, 71, 80; S9 architecture (ADR 0003), with the approved amendments.
--
-- * S8-07 final ruling (N1): an opening-balance line needs an explicitly classified account that
--   is neither a receivable nor a control account. Nothing is inferred.
-- * Decision 53 amendment (N9): OTHER_CURRENT_ASSET and OTHER_ASSET accounts may be marked
--   monetary explicitly. They are never monetary by default.
-- * Revaluation runs (DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED; S9 creates a run as a
--   DRAFT and posts it in the same transaction, the approval states are ready for Phase 4),
--   their calculated lines, and the link from a run to its journals with the journal's role
--   (REVALUATION on D, SCHEDULED_REVERSAL on D + 1, CANCELLATION when a run is reversed).
-- * Database protections: lines and links are written only at the allowed stages and are then
--   immutable; runs follow the allowed transitions; only DRAFT runs can be deleted; a linked
--   journal must carry the run as its source.

-- ---------------------------------------------------------------------------
-- S8-07: opening-balance accounts must be explicitly classified
-- ---------------------------------------------------------------------------

CREATE FUNCTION accounting_guard_opening_balance_line_account() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_account record;
BEGIN
  SELECT subtype, is_control_account INTO v_account
    FROM accounting_accounts
   WHERE id = NEW.account_id AND organization_id = NEW.organization_id;
  IF v_account.subtype IS NULL THEN
    RAISE EXCEPTION 'Opening balances need an explicitly classified account (account %).', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_account.subtype = 'ACCOUNTS_RECEIVABLE' OR v_account.is_control_account THEN
    RAISE EXCEPTION 'Receivable and control accounts cannot take opening balances (account %).', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_opening_balance_lines_account_guard
  BEFORE INSERT OR UPDATE OF account_id ON accounting_opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_opening_balance_line_account();

-- ---------------------------------------------------------------------------
-- Decision 53 amendment: explicit monetary marking on other assets
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_accounts DROP CONSTRAINT accounting_accounts_monetary;
ALTER TABLE accounting_accounts ADD CONSTRAINT accounting_accounts_monetary CHECK (
  CASE
    WHEN subtype IN ('BANK', 'CASH', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'CREDIT_CARD') THEN is_monetary
    WHEN subtype IN ('OTHER_CURRENT_ASSET', 'OTHER_ASSET', 'OTHER_CURRENT_LIABILITY',
                     'LONG_TERM_LIABILITY') THEN true
    ELSE NOT is_monetary
  END
);

-- ---------------------------------------------------------------------------
-- Revaluation runs
-- ---------------------------------------------------------------------------

-- Tenant-safe reference from a run to the job that ran it (Phase 4 scheduled runs).
ALTER TABLE jobs ADD CONSTRAINT jobs_id_organization_key UNIQUE (id, organization_id);

CREATE TABLE accounting_revaluation_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                 text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED')),
  -- REVERSING: the revaluation is reversed on the next day. ADJUSTING is reserved for Phase 4.
  method                 text NOT NULL DEFAULT 'REVERSING' CHECK (method IN ('REVERSING', 'ADJUSTING')),
  revaluation_date       date NOT NULL,
  reversal_date          date,
  base_currency          char(3) NOT NULL REFERENCES accounting_currencies (code),
  unrealized_account_id  uuid NOT NULL,
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  run_key                text CHECK (length(run_key) BETWEEN 1 AND 200),
  approval_request_id    uuid,
  job_id                 uuid,
  trigger                text NOT NULL DEFAULT 'user' CHECK (trigger IN ('user', 'job')),
  -- Signed base-currency totals (a positive net is a gain).
  net_adjustment         numeric(28, 4) NOT NULL DEFAULT 0,
  total_gain             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total_gain >= 0),
  total_loss             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total_loss >= 0),
  line_count             integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  posted_by_user_id      uuid REFERENCES users (id),
  posted_at              timestamptz,
  reversed_by_user_id    uuid REFERENCES users (id),
  reversed_at            timestamptz,
  reversal_reason        text CHECK (length(btrim(reversal_reason)) BETWEEN 3 AND 500),
  CONSTRAINT accounting_revaluation_runs_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_revaluation_runs_run_key UNIQUE (organization_id, run_key),
  CONSTRAINT accounting_revaluation_runs_unrealized_fkey FOREIGN KEY (unrealized_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT accounting_revaluation_runs_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT accounting_revaluation_runs_job_fkey FOREIGN KEY (job_id, organization_id)
    REFERENCES jobs (id, organization_id),
  CONSTRAINT accounting_revaluation_runs_reversal_date CHECK (
    (method = 'REVERSING' AND reversal_date = revaluation_date + 1)
    OR (method = 'ADJUSTING' AND reversal_date IS NULL)),
  CONSTRAINT accounting_revaluation_runs_totals CHECK (net_adjustment = total_gain - total_loss),
  CONSTRAINT accounting_revaluation_runs_state_consistency CHECK (
    (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL)
    AND ((status IN ('POSTED', 'REVERSED')) = (posted_at IS NOT NULL AND posted_by_user_id IS NOT NULL))
    AND ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversed_by_user_id IS NOT NULL
                                  AND reversal_reason IS NOT NULL)))
);
-- One active run per revaluation date; a date can be revalued again once its run is reversed.
CREATE UNIQUE INDEX accounting_revaluation_runs_one_per_date_idx
  ON accounting_revaluation_runs (organization_id, revaluation_date)
  WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED');
CREATE INDEX accounting_revaluation_runs_org_date_idx
  ON accounting_revaluation_runs (organization_id, revaluation_date DESC);

-- ---------------------------------------------------------------------------
-- Revaluation lines: one per exposure (account, or open document in later phases)
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_revaluation_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  run_id           uuid NOT NULL,
  line_number      integer NOT NULL CHECK (line_number BETWEEN 1 AND 1000000),
  exposure_kind    text NOT NULL CHECK (exposure_kind IN ('ACCOUNT', 'DOCUMENT')),
  -- The GL account the adjustment posts to (for a document, its control account).
  account_id       uuid NOT NULL,
  currency_code    char(3) NOT NULL REFERENCES accounting_currencies (code),
  document_module  text CHECK (document_module ~ '^[a-z][a-z0-9_-]*$'),
  document_type    text CHECK (document_type ~ '^[a-z][a-z0-9_]*$'),
  document_id      uuid,
  -- Signed, debit-positive: F (transaction currency) and B (carrying base amount) at the date.
  foreign_balance  numeric(28, 4) NOT NULL,
  carrying_base    numeric(28, 4) NOT NULL,
  rate             numeric(28, 10) NOT NULL CHECK (rate > 0),
  rate_date        date NOT NULL,
  rate_source      text NOT NULL CHECK (rate_source IN ('table', 'manual')),
  -- T = round(F x rate) and A = T - B.
  revalued_base    numeric(28, 4) NOT NULL,
  adjustment       numeric(28, 4) NOT NULL,
  CONSTRAINT accounting_revaluation_lines_run_fkey FOREIGN KEY (run_id, organization_id)
    REFERENCES accounting_revaluation_runs (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT accounting_revaluation_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT accounting_revaluation_lines_number_key UNIQUE (run_id, line_number),
  CONSTRAINT accounting_revaluation_lines_exposure_key
    UNIQUE NULLS NOT DISTINCT (run_id, account_id, document_module, document_type, document_id),
  CONSTRAINT accounting_revaluation_lines_document CHECK (
    (exposure_kind = 'ACCOUNT' AND document_module IS NULL AND document_type IS NULL AND document_id IS NULL)
    OR (exposure_kind = 'DOCUMENT' AND document_module IS NOT NULL AND document_type IS NOT NULL
        AND document_id IS NOT NULL)),
  CONSTRAINT accounting_revaluation_lines_adjustment CHECK (adjustment = revalued_base - carrying_base)
);
CREATE INDEX accounting_revaluation_lines_account_idx
  ON accounting_revaluation_lines (organization_id, account_id);

-- ---------------------------------------------------------------------------
-- Run -> journal links with the journal's role
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_revaluation_run_journals (
  organization_id  uuid NOT NULL,
  run_id           uuid NOT NULL,
  journal_id       uuid NOT NULL,
  currency         char(3) NOT NULL REFERENCES accounting_currencies (code),
  role             text NOT NULL CHECK (role IN ('REVALUATION', 'SCHEDULED_REVERSAL', 'CANCELLATION')),
  PRIMARY KEY (run_id, journal_id),
  CONSTRAINT accounting_revaluation_run_journals_journal_key UNIQUE (journal_id),
  CONSTRAINT accounting_revaluation_run_journals_run_fkey FOREIGN KEY (run_id, organization_id)
    REFERENCES accounting_revaluation_runs (id, organization_id),
  CONSTRAINT accounting_revaluation_run_journals_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
CREATE INDEX accounting_revaluation_run_journals_org_run_idx
  ON accounting_revaluation_run_journals (organization_id, run_id);

-- ---------------------------------------------------------------------------
-- Protections
-- ---------------------------------------------------------------------------

CREATE FUNCTION accounting_guard_revaluation_run() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A run is created as a DRAFT; its lines and journals are added before it is posted.
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Revaluation runs are created as drafts.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only draft revaluation runs can be deleted (run %).', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.created_by_user_id, NEW.created_at, NEW.run_key,
      NEW.method, NEW.revaluation_date, NEW.reversal_date, NEW.base_currency,
      NEW.unrealized_account_id, NEW.trigger, NEW.job_id)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.created_by_user_id, OLD.created_at, OLD.run_key,
      OLD.method, OLD.revaluation_date, OLD.reversal_date, OLD.base_currency,
      OLD.unrealized_account_id, OLD.trigger, OLD.job_id) THEN
    RAISE EXCEPTION 'Revaluation run identity cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'A reversed revaluation run is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'POSTED' THEN
    -- Only the move to REVERSED, leaving the posted figures untouched.
    IF NEW.status <> 'REVERSED'
       OR (NEW.net_adjustment, NEW.total_gain, NEW.total_loss, NEW.line_count,
           NEW.approval_request_id, NEW.posted_by_user_id, NEW.posted_at)
          IS DISTINCT FROM
          (OLD.net_adjustment, OLD.total_gain, OLD.total_loss, OLD.line_count,
           OLD.approval_request_id, OLD.posted_by_user_id, OLD.posted_at) THEN
      RAISE EXCEPTION 'A posted revaluation run can only be reversed.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'POSTED'))) THEN
    RAISE EXCEPTION 'Invalid revaluation run transition % -> %.', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_revaluation_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_revaluation_runs
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_revaluation_run();
CREATE TRIGGER accounting_revaluation_runs_no_truncate
  BEFORE TRUNCATE ON accounting_revaluation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- Lines are written only while their run is a draft. (When a draft is deleted, its row is gone
-- before its lines cascade, which is allowed.)
CREATE FUNCTION accounting_guard_revaluation_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_run    uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'Revaluation lines cannot move between runs.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM accounting_revaluation_runs WHERE id = v_run;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Revaluation lines can only change while the run is a draft.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER accounting_revaluation_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_revaluation_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_revaluation_line();
CREATE TRIGGER accounting_revaluation_lines_no_truncate
  BEFORE TRUNCATE ON accounting_revaluation_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- Links are append-only. REVALUATION and SCHEDULED_REVERSAL links are added while the run is
-- being posted (DRAFT); CANCELLATION links while a POSTED run is being reversed. The journal must
-- carry the run as its source (Decision 12) with the type matching its role.
CREATE FUNCTION accounting_guard_revaluation_run_journal() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status  text;
  v_journal record;
BEGIN
  SELECT status INTO v_status FROM accounting_revaluation_runs
   WHERE id = NEW.run_id AND organization_id = NEW.organization_id;
  IF NOT ((NEW.role IN ('REVALUATION', 'SCHEDULED_REVERSAL') AND v_status = 'DRAFT')
          OR (NEW.role = 'CANCELLATION' AND v_status = 'POSTED')) THEN
    RAISE EXCEPTION 'A % journal cannot be linked to a % revaluation run.', NEW.role, v_status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT source, source_module, source_type, source_id, currency INTO v_journal
    FROM accounting_journal_entries
   WHERE id = NEW.journal_id AND organization_id = NEW.organization_id;
  IF v_journal.source IS DISTINCT FROM 'system'
     OR v_journal.source_module IS DISTINCT FROM 'accounting'
     OR v_journal.source_id IS DISTINCT FROM NEW.run_id
     OR v_journal.source_type IS DISTINCT FROM
        (CASE WHEN NEW.role = 'REVALUATION' THEN 'revaluation' ELSE 'revaluation_reversal' END)
     OR v_journal.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'Journal % is not a % journal of revaluation run %.', NEW.journal_id, NEW.role, NEW.run_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_revaluation_run_journals_guard
  BEFORE INSERT ON accounting_revaluation_run_journals
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_revaluation_run_journal();
CREATE TRIGGER accounting_revaluation_run_journals_append_only
  BEFORE UPDATE OR DELETE ON accounting_revaluation_run_journals
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER accounting_revaluation_run_journals_no_truncate
  BEFORE TRUNCATE ON accounting_revaluation_run_journals
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_revaluation_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_revaluation_lines        ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_revaluation_run_journals ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_revaluation_runs_tenant ON accounting_revaluation_runs FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY accounting_revaluation_lines_tenant ON accounting_revaluation_lines FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY accounting_revaluation_run_journals_tenant ON accounting_revaluation_run_journals FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON accounting_revaluation_runs, accounting_revaluation_lines,
  accounting_revaluation_run_journals FROM PUBLIC;
-- DELETE exists only for draft runs (Phase 4); the triggers refuse anything else.
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_revaluation_runs TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_revaluation_lines TO intuit_app;
GRANT SELECT, INSERT ON accounting_revaluation_run_journals TO intuit_app;
