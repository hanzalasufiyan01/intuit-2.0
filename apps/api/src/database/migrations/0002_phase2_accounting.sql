-- Intuit 2.0 — Phase 2: Accounting Foundation & General Ledger, and the reusable
-- Authority & Approval framework.
--
-- Module ownership of tables:
--   approvals   approval_policies, approval_policy_steps, approval_step_eligible_roles,
--               approval_step_eligible_members, approval_requests, approval_decisions
--   accounting  accounting_settings, accounting_coa_templates, accounting_coa_template_accounts,
--               accounting_accounts, accounting_exchange_rates, accounting_fiscal_years,
--               accounting_periods, accounting_journal_entries, accounting_journal_lines,
--               accounting_journal_reversals, accounting_events
--
-- Financial amounts are PostgreSQL numeric (exact). Posted journals, their lines and
-- approval decisions are protected by triggers in addition to application rules.

-- ---------------------------------------------------------------------------
-- Permission keys: Phase 2 permissions have three segments (accounting.journals.post).
-- ---------------------------------------------------------------------------

ALTER TABLE permissions DROP CONSTRAINT permissions_key_check;
ALTER TABLE permissions ADD CONSTRAINT permissions_key_check
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- Non-overlapping date ranges per organization (fiscal years, periods).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- approvals (reusable Authority & Approval framework)
-- ---------------------------------------------------------------------------

-- One policy per organization and approvable action (e.g. accounting.journal.post).
CREATE TABLE approval_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  action_key      text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_organization_action_key UNIQUE (organization_id, action_key),
  CONSTRAINT approval_policies_id_organization_key UNIQUE (id, organization_id)
);
CREATE TRIGGER approval_policies_touch_updated_at BEFORE UPDATE ON approval_policies
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Steps are AND-ed; each step needs required_approvals distinct eligible approvers.
CREATE TABLE approval_policy_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  policy_id          uuid NOT NULL,
  step_order         integer NOT NULL CHECK (step_order >= 1),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 20),
  CONSTRAINT approval_policy_steps_policy_fkey FOREIGN KEY (policy_id, organization_id)
    REFERENCES approval_policies (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT approval_policy_steps_policy_order_key UNIQUE (policy_id, step_order),
  CONSTRAINT approval_policy_steps_id_organization_key UNIQUE (id, organization_id)
);

CREATE TABLE approval_step_eligible_roles (
  step_id         uuid NOT NULL,
  organization_id uuid NOT NULL,
  role_id         uuid NOT NULL,
  PRIMARY KEY (step_id, role_id),
  CONSTRAINT approval_step_eligible_roles_step_fkey FOREIGN KEY (step_id, organization_id)
    REFERENCES approval_policy_steps (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT approval_step_eligible_roles_role_fkey FOREIGN KEY (role_id, organization_id)
    REFERENCES roles (id, organization_id)
);

CREATE TABLE approval_step_eligible_members (
  step_id         uuid NOT NULL,
  organization_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  PRIMARY KEY (step_id, membership_id),
  CONSTRAINT approval_step_eligible_members_step_fkey FOREIGN KEY (step_id, organization_id)
    REFERENCES approval_policy_steps (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT approval_step_eligible_members_membership_fkey FOREIGN KEY (membership_id, organization_id)
    REFERENCES memberships (id, organization_id)
);

-- A request snapshots the policy at submission, so later policy edits never change
-- the rules for work already in flight.
CREATE TABLE approval_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id),
  action_key           text NOT NULL,
  subject_type         text NOT NULL,
  subject_id           uuid NOT NULL,
  policy_snapshot      jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by_user_id uuid NOT NULL REFERENCES users (id),
  -- Users who may never approve this request (self-approval prohibition).
  excluded_user_ids    uuid[] NOT NULL DEFAULT '{}',
  reason               text,
  created_at           timestamptz NOT NULL,
  resolved_at          timestamptz,
  CONSTRAINT approval_requests_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT approval_requests_resolution_consistency CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX approval_requests_single_pending_idx
  ON approval_requests (organization_id, action_key, subject_id) WHERE status = 'pending';
CREATE INDEX approval_requests_organization_status_idx ON approval_requests (organization_id, status, created_at DESC);

-- Append-only record of approval decisions.
CREATE TABLE approval_decisions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  request_id             uuid NOT NULL,
  step_order             integer NOT NULL CHECK (step_order >= 1),
  approver_membership_id uuid NOT NULL,
  approver_user_id       uuid NOT NULL REFERENCES users (id),
  decision               text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment                text CHECK (comment IS NULL OR length(comment) <= 1000),
  decided_at             timestamptz NOT NULL,
  CONSTRAINT approval_decisions_request_fkey FOREIGN KEY (request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT approval_decisions_membership_fkey FOREIGN KEY (approver_membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  -- One decision per person per request: one person can never satisfy two steps.
  CONSTRAINT approval_decisions_request_approver_key UNIQUE (request_id, approver_membership_id)
);
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER approval_decisions_no_truncate BEFORE TRUNCATE ON approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- accounting: setup and Chart of Accounts
-- ---------------------------------------------------------------------------

-- Global COA template reference data (seeded by the migration role).
CREATE TABLE accounting_coa_templates (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text NOT NULL,
  description text NOT NULL,
  sort_order  integer NOT NULL
);

CREATE TABLE accounting_coa_template_accounts (
  template_key text NOT NULL REFERENCES accounting_coa_templates (key) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  parent_code  text,
  sort_order   integer NOT NULL,
  PRIMARY KEY (template_key, code),
  CONSTRAINT accounting_coa_template_accounts_parent_fkey FOREIGN KEY (template_key, parent_code)
    REFERENCES accounting_coa_template_accounts (template_key, code)
);

-- One row per organization once accounting setup is complete.
CREATE TABLE accounting_settings (
  organization_id      uuid PRIMARY KEY REFERENCES organizations (id),
  base_currency        char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  coa_template_key     text NOT NULL REFERENCES accounting_coa_templates (key),
  -- Journal numbers are assigned at posting from this counter (gapless not required).
  next_journal_number  bigint NOT NULL DEFAULT 1 CHECK (next_journal_number >= 1),
  setup_by_user_id     uuid NOT NULL REFERENCES users (id),
  setup_at             timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER accounting_settings_touch_updated_at BEFORE UPDATE ON accounting_settings
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE accounting_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  account_type        text NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  parent_id           uuid,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  is_system           boolean NOT NULL DEFAULT false,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_by_user_id uuid REFERENCES users (id),
  archived_at         timestamptz,
  CONSTRAINT accounting_accounts_organization_code_key UNIQUE (organization_id, code),
  CONSTRAINT accounting_accounts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_accounts_id_organization_type_key UNIQUE (id, organization_id, account_type),
  -- A parent is in the same organization and has the same account type.
  CONSTRAINT accounting_accounts_parent_fkey FOREIGN KEY (parent_id, organization_id, account_type)
    REFERENCES accounting_accounts (id, organization_id, account_type),
  CONSTRAINT accounting_accounts_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT accounting_accounts_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX accounting_accounts_organization_parent_idx ON accounting_accounts (organization_id, parent_id);
CREATE TRIGGER accounting_accounts_touch_updated_at BEFORE UPDATE ON accounting_accounts
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Organization exchange-rate table: 1 unit of from_currency = rate units of the base currency.
-- Rows are append-only in practice (no update/delete grants); posted journals copy their rate.
CREATE TABLE accounting_exchange_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES accounting_settings (organization_id),
  from_currency      char(3) NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency        char(3) NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
  rate_date          date NOT NULL,
  rate               numeric(28, 10) NOT NULL CHECK (rate > 0),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_exchange_rates_distinct CHECK (from_currency <> to_currency),
  CONSTRAINT accounting_exchange_rates_key UNIQUE (organization_id, from_currency, to_currency, rate_date)
);

-- ---------------------------------------------------------------------------
-- accounting: fiscal years and periods
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_fiscal_years (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES accounting_settings (organization_id),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_fiscal_years_dates CHECK (end_date >= start_date),
  CONSTRAINT accounting_fiscal_years_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_fiscal_years_organization_name_key UNIQUE (organization_id, name),
  CONSTRAINT accounting_fiscal_years_no_overlap EXCLUDE USING gist
    (organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

CREATE TABLE accounting_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  fiscal_year_id       uuid NOT NULL,
  period_number        integer NOT NULL CHECK (period_number >= 1),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  start_date           date NOT NULL,
  end_date             date NOT NULL,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_at            timestamptz,
  closed_by_user_id    uuid REFERENCES users (id),
  reopened_at          timestamptz,
  reopened_by_user_id  uuid REFERENCES users (id),
  reopen_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_fiscal_year_fkey FOREIGN KEY (fiscal_year_id, organization_id)
    REFERENCES accounting_fiscal_years (id, organization_id),
  CONSTRAINT accounting_periods_dates CHECK (end_date >= start_date),
  CONSTRAINT accounting_periods_number_key UNIQUE (fiscal_year_id, period_number),
  CONSTRAINT accounting_periods_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_periods_closed_consistency CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT accounting_periods_no_overlap EXCLUDE USING gist
    (organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX accounting_periods_organization_dates_idx ON accounting_periods (organization_id, start_date);

-- ---------------------------------------------------------------------------
-- accounting: journals
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_journal_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  -- Human-facing number, assigned at posting only.
  journal_number        bigint,
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED')),
  source                text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'reversal', 'event')),
  entry_date            date,
  period_id             uuid,
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  reference             text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  currency              char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Transaction -> base conversion rate. Preserved permanently once posted.
  exchange_rate         numeric(28, 10) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  exchange_rate_source  text CHECK (exchange_rate_source IN ('base', 'manual', 'table')),
  base_currency         char(3) CHECK (base_currency ~ '^[A-Z]{3}$'),
  total_debit           numeric(28, 4),
  total_credit          numeric(28, 4),
  total_base_debit      numeric(28, 4),
  total_base_credit     numeric(28, 4),
  approval_request_id   uuid,
  accounting_event_id   uuid,
  created_by_user_id    uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  submitted_by_user_id  uuid REFERENCES users (id),
  submitted_at          timestamptz,
  posted_by_user_id     uuid REFERENCES users (id),
  posted_at             timestamptz,
  reversed_by_user_id   uuid REFERENCES users (id),
  reversed_at           timestamptz,
  CONSTRAINT accounting_journal_entries_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_journal_entries_number_key UNIQUE (organization_id, journal_number),
  CONSTRAINT accounting_journal_entries_period_fkey FOREIGN KEY (period_id, organization_id)
    REFERENCES accounting_periods (id, organization_id),
  CONSTRAINT accounting_journal_entries_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT accounting_journal_entries_posted_consistency CHECK (
    (status IN ('POSTED', 'REVERSED')) = (journal_number IS NOT NULL AND posted_at IS NOT NULL)
  ),
  CONSTRAINT accounting_journal_entries_posted_complete CHECK (
    status NOT IN ('POSTED', 'REVERSED') OR (
      entry_date IS NOT NULL AND period_id IS NOT NULL AND exchange_rate IS NOT NULL
      AND base_currency IS NOT NULL AND total_debit = total_credit
      AND total_base_debit = total_base_credit AND total_debit > 0
    )
  ),
  CONSTRAINT accounting_journal_entries_reversed_consistency CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL))
);
CREATE INDEX accounting_journal_entries_organization_status_idx
  ON accounting_journal_entries (organization_id, status, created_at DESC);
CREATE INDEX accounting_journal_entries_organization_period_idx
  ON accounting_journal_entries (organization_id, period_id);
CREATE INDEX accounting_journal_entries_organization_date_idx
  ON accounting_journal_entries (organization_id, entry_date);

CREATE TABLE accounting_journal_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  journal_id          uuid NOT NULL,
  line_number         integer NOT NULL CHECK (line_number >= 1),
  -- Nullable only while the journal is a draft (drafts may be incomplete, and deleting
  -- an unused account clears draft-only references).
  account_id          uuid,
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  debit               numeric(28, 4) CHECK (debit IS NULL OR debit > 0),
  credit              numeric(28, 4) CHECK (credit IS NULL OR credit > 0),
  base_debit          numeric(28, 4) CHECK (base_debit IS NULL OR base_debit > 0),
  base_credit         numeric(28, 4) CHECK (base_credit IS NULL OR base_credit > 0),
  -- Base-currency rounding difference applied to this line (largest-eligible-line rule).
  rounding_adjustment numeric(28, 4) NOT NULL DEFAULT 0,
  CONSTRAINT accounting_journal_lines_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT accounting_journal_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT accounting_journal_lines_number_key UNIQUE (journal_id, line_number),
  CONSTRAINT accounting_journal_lines_one_side CHECK (NOT (debit IS NOT NULL AND credit IS NOT NULL)),
  CONSTRAINT accounting_journal_lines_one_base_side CHECK (NOT (base_debit IS NOT NULL AND base_credit IS NOT NULL))
);
CREATE INDEX accounting_journal_lines_journal_idx ON accounting_journal_lines (journal_id);
CREATE INDEX accounting_journal_lines_organization_account_idx
  ON accounting_journal_lines (organization_id, account_id);

CREATE TABLE accounting_journal_reversals (
  organization_id     uuid NOT NULL,
  original_journal_id uuid NOT NULL,
  reversal_journal_id uuid NOT NULL,
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (original_journal_id),
  CONSTRAINT accounting_journal_reversals_reversal_key UNIQUE (reversal_journal_id),
  CONSTRAINT accounting_journal_reversals_original_fkey FOREIGN KEY (original_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT accounting_journal_reversals_reversal_fkey FOREIGN KEY (reversal_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT accounting_journal_reversals_distinct CHECK (original_journal_id <> reversal_journal_id)
);
CREATE TRIGGER accounting_journal_reversals_append_only BEFORE UPDATE OR DELETE ON accounting_journal_reversals
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- accounting: events (idempotent inbox from operational modules)
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES accounting_settings (organization_id),
  source_module   text NOT NULL CHECK (source_module ~ '^[a-z][a-z0-9_-]*$'),
  event_type      text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- Idempotency key supplied by the source module.
  event_key       text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed')),
  journal_id      uuid,
  error           text,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL,
  processed_at    timestamptz,
  CONSTRAINT accounting_events_idempotency_key UNIQUE (organization_id, source_module, event_key),
  CONSTRAINT accounting_events_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_events_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
CREATE INDEX accounting_events_organization_status_idx ON accounting_events (organization_id, status);

ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_event_fkey
  FOREIGN KEY (accounting_event_id, organization_id) REFERENCES accounting_events (id, organization_id);

-- ---------------------------------------------------------------------------
-- Accounting integrity triggers (defence-in-depth behind the posting engine)
-- ---------------------------------------------------------------------------

-- Posting guard: a journal can only become POSTED when balanced, >= 2 valid lines,
-- and dated inside an OPEN period. Posted/reversed journals are immutable, except the
-- single lifecycle transition POSTED -> REVERSED.
CREATE FUNCTION accounting_guard_journal_entry() RETURNS trigger
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
           count(*) FILTER (WHERE account_id IS NULL
                             OR (debit IS NULL) = (credit IS NULL)
                             OR (base_debit IS NULL) = (base_credit IS NULL)
                             OR (debit IS NULL) <> (base_debit IS NULL)) AS invalid,
           coalesce(sum(debit), 0) AS debit, coalesce(sum(credit), 0) AS credit,
           coalesce(sum(base_debit), 0) AS base_debit, coalesce(sum(base_credit), 0) AS base_credit
      INTO v_lines
      FROM accounting_journal_lines WHERE journal_id = NEW.id;
    IF v_lines.n < 2 OR v_lines.invalid > 0
       OR v_lines.debit <> v_lines.credit OR v_lines.base_debit <> v_lines.base_credit
       OR v_lines.debit <> NEW.total_debit OR v_lines.base_debit <> NEW.total_base_debit THEN
      RAISE EXCEPTION 'journal % is not a valid balanced double entry', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_journal_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_journal_entry();

-- Lines are editable only while their journal is a DRAFT. While PENDING_APPROVAL only the
-- posting engine's base-currency columns may be written. Posted lines are immutable.
CREATE FUNCTION accounting_guard_journal_line() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_status text;
  v_row accounting_journal_lines;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT status INTO v_status FROM accounting_journal_entries
    WHERE id = v_row.journal_id AND organization_id = v_row.organization_id;
  IF v_status = 'DRAFT' THEN
    RETURN v_row;
  END IF;
  IF v_status = 'PENDING_APPROVAL' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - ARRAY['base_debit', 'base_credit', 'rounding_adjustment'])
       = (to_jsonb(OLD) - ARRAY['base_debit', 'base_credit', 'rounding_adjustment']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lines of % journal % cannot be modified', coalesce(v_status, 'missing'), v_row.journal_id
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER accounting_journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_journal_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_journal_line();
CREATE TRIGGER accounting_journal_lines_no_truncate BEFORE TRUNCATE ON accounting_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER accounting_journal_entries_no_truncate BEFORE TRUNCATE ON accounting_journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Row-Level Security (defence-in-depth)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_policies', 'approval_policy_steps', 'approval_step_eligible_roles',
    'approval_step_eligible_members', 'approval_requests', 'approval_decisions',
    'accounting_settings', 'accounting_accounts', 'accounting_exchange_rates',
    'accounting_fiscal_years', 'accounting_periods', 'accounting_journal_entries',
    'accounting_journal_lines', 'accounting_journal_reversals', 'accounting_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id = app_current_organization_id()) '
      'WITH CHECK (organization_id = app_current_organization_id())',
      t || '_tenant', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants for the runtime application role (least privilege)
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON accounting_coa_templates, accounting_coa_template_accounts TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON accounting_settings TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_accounts TO intuit_app;
GRANT SELECT, INSERT ON accounting_exchange_rates, accounting_fiscal_years TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON accounting_periods TO intuit_app;
-- No DELETE on journal entries: there is no journal deletion in Phase 2.
GRANT SELECT, INSERT, UPDATE ON accounting_journal_entries TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_journal_lines TO intuit_app;
GRANT SELECT, INSERT ON accounting_journal_reversals TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON accounting_events TO intuit_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_policies, approval_policy_steps,
  approval_step_eligible_roles, approval_step_eligible_members TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON approval_requests TO intuit_app;
GRANT SELECT, INSERT ON approval_decisions TO intuit_app;
