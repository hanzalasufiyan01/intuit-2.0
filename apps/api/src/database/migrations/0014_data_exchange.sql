-- Intuit 2.0 — Phase 3A, S6: import and export (Decisions 7, 23, 24, 61, 65, 75; S6-01..S6-46;
-- rulings L-1..L-12).
--
--   * import_batches / import_rows: every import is a batch whose rows are staged, validated in
--     full (L-1) and committed atomically through the owning modules' services. Rows are never
--     deleted; their source and normalized data are redacted 30 days after the batch ends (L-11).
--   * import_mappings: saved column mappings per organization and domain (soft-deleted).
--   * exports: generated files (CSV) produced by the job runner and stored through S5 storage.
--   * file_links gains the link types import_batch and export (S5-04).
--   * Journals gain the terminal status DISCARDED (L-9): only never-submitted drafts created by an
--     import may be discarded. Journals are never physically deleted.
--   * app_organizations_with_data_exchange_work(): narrow SECURITY DEFINER discovery for the
--     hourly cleanup scheduler; returns organization ids only.

-- ---------------------------------------------------------------------------
-- Import batches and rows
-- ---------------------------------------------------------------------------

CREATE TABLE import_batches (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations (id),
  domain                    text NOT NULL CHECK (domain IN (
    'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
    'manual_journals')),
  format                    text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  status                    text NOT NULL DEFAULT 'awaiting_file' CHECK (status IN (
    'awaiting_file', 'ready', 'validating', 'validated', 'failed_file', 'committing',
    'committed', 'needs_review', 'cancelled', 'expired')),
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  file_id                   uuid,
  options                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  mapping                   jsonb CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object'),
  mapping_version           integer NOT NULL DEFAULT 0 CHECK (mapping_version >= 0),
  validated_mapping_version integer,
  columns                   jsonb CHECK (columns IS NULL OR jsonb_typeof(columns) = 'array'),
  row_count                 integer NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 25000),
  valid_count               integer NOT NULL DEFAULT 0 CHECK (valid_count >= 0),
  warning_count             integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  error_count               integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  excluded_count            integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  summary                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  file_sha256               text CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id        uuid NOT NULL REFERENCES users (id),
  committed_by_user_id      uuid REFERENCES users (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  committed_at              timestamptz,
  finished_at               timestamptz,
  expires_at                timestamptz NOT NULL,
  redacted_at               timestamptz,
  CONSTRAINT import_batches_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT import_batches_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT import_batches_committed_consistency CHECK (
    (status = 'committed') = (committed_at IS NOT NULL AND committed_by_user_id IS NOT NULL)),
  CONSTRAINT import_batches_finished_consistency CHECK (
    (status IN ('committed', 'cancelled', 'expired', 'failed_file')) = (finished_at IS NOT NULL)),
  CONSTRAINT import_batches_redacted_only_finished CHECK (redacted_at IS NULL OR finished_at IS NOT NULL)
);
CREATE INDEX import_batches_organization_idx ON import_batches (organization_id, created_at DESC);
CREATE INDEX import_batches_open_idx ON import_batches (expires_at)
  WHERE status IN ('awaiting_file', 'ready', 'validated', 'needs_review');
CREATE INDEX import_batches_sha_idx ON import_batches (organization_id, domain, file_sha256)
  WHERE status = 'committed';

CREATE TABLE import_rows (
  batch_id        uuid NOT NULL,
  organization_id uuid NOT NULL,
  row_number      integer NOT NULL CHECK (row_number BETWEEN 1 AND 25000),
  group_key       text CHECK (length(group_key) <= 200),
  -- Source cells as parsed (array of strings) and the typed values; redacted after 30 days (L-11).
  raw             jsonb CHECK (raw IS NULL OR jsonb_typeof(raw) = 'array'),
  normalized      jsonb CHECK (normalized IS NULL OR jsonb_typeof(normalized) = 'object'),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'valid', 'warning', 'error')),
  excluded        boolean NOT NULL DEFAULT false,
  -- Codes, fields and generic messages only (no cell values).
  messages        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
  record_id       uuid,
  PRIMARY KEY (batch_id, row_number),
  CONSTRAINT import_rows_batch_fkey FOREIGN KEY (batch_id, organization_id)
    REFERENCES import_batches (id, organization_id)
);
CREATE INDEX import_rows_status_idx ON import_rows (batch_id, status, row_number);

-- ---------------------------------------------------------------------------
-- Saved column mappings
-- ---------------------------------------------------------------------------

CREATE TABLE import_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id),
  domain             text NOT NULL CHECK (domain IN (
    'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
    'manual_journals')),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- Target field key -> source header (normalized) so a mapping applies to any file layout.
  mapping            jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  options            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX import_mappings_name_key ON import_mappings (organization_id, domain, lower(name))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Exports
-- ---------------------------------------------------------------------------

CREATE TABLE exports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  domain              text NOT NULL CHECK (domain IN (
    'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
    'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors')),
  format              text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  params              jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 8192),
  -- The view permission the export needs, re-checked on every access (Decision 65).
  required_permission text NOT NULL,
  file_id             uuid,
  row_count           integer CHECK (row_count >= 0),
  error               text CHECK (length(error) <= 500),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  expires_at          timestamptz NOT NULL,
  CONSTRAINT exports_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT exports_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT exports_ready_has_file CHECK (status <> 'ready' OR file_id IS NOT NULL),
  CONSTRAINT exports_finished_consistency CHECK (
    (status IN ('ready', 'failed', 'expired')) = (finished_at IS NOT NULL))
);
CREATE INDEX exports_organization_idx ON exports (organization_id, created_at DESC);
CREATE INDEX exports_expiry_idx ON exports (expires_at) WHERE status = 'ready';

-- ---------------------------------------------------------------------------
-- File links: import batches and exports (S5-04)
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export'));

-- ---------------------------------------------------------------------------
-- Journals: DISCARDED (L-9)
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_journal_entries DROP CONSTRAINT accounting_journal_entries_status_check;
ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_status_check
  CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED', 'DISCARDED'));
ALTER TABLE accounting_journal_entries
  ADD COLUMN discarded_at timestamptz,
  ADD COLUMN discarded_by_user_id uuid REFERENCES users (id);
ALTER TABLE accounting_journal_entries ADD CONSTRAINT accounting_journal_entries_discarded_consistency
  CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL));

-- The 0007 guard, plus: a discarded journal is immutable, and only a never-submitted manual draft
-- created by an import may become DISCARDED, changing nothing else.
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

  -- L-9: DISCARDED is terminal and immutable.
  IF TG_OP = 'UPDATE' AND OLD.status = 'DISCARDED' THEN
    RAISE EXCEPTION 'discarded journal % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'DISCARDED' THEN
    -- NULL-safe: a manual draft without source references must be refused, not let through.
    IF NOT coalesce(
         OLD.status = 'DRAFT' AND OLD.submitted_at IS NULL AND OLD.source = 'manual'
         AND OLD.source_module IS NOT DISTINCT FROM 'data_exchange'
         AND OLD.source_type IS NOT DISTINCT FROM 'import_batch'
         AND NEW.discarded_at IS NOT NULL AND NEW.discarded_by_user_id IS NOT NULL
         AND (to_jsonb(NEW) - ARRAY['status', 'discarded_at', 'discarded_by_user_id',
                                     'updated_at', 'updated_by_user_id'])
           = (to_jsonb(OLD) - ARRAY['status', 'discarded_at', 'discarded_by_user_id',
                                     'updated_at', 'updated_by_user_id']),
         false) THEN
      RAISE EXCEPTION 'only never-submitted imported drafts can be discarded (journal %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
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
    -- Decisions 78, 84, 86: a manual journal line whose account is in the account-classification
    -- scope of an active required dimension type must carry a value of that type.
    IF NEW.source = 'manual' AND EXISTS (
      SELECT 1
        FROM accounting_journal_lines l
        JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
        JOIN accounting_dimension_types t
          ON t.organization_id = l.organization_id AND t.status = 'ACTIVE' AND t.is_required
         AND (a.account_type = ANY (t.scope_account_types) OR a.subtype = ANY (t.scope_account_subtypes))
       WHERE l.journal_id = NEW.id AND l.organization_id = NEW.organization_id
         AND NOT EXISTS (
           SELECT 1 FROM accounting_journal_line_dimensions d
            WHERE d.journal_line_id = l.id AND d.organization_id = l.organization_id
              AND d.dimension_type_id = t.id)
    ) THEN
      RAISE EXCEPTION 'journal % is missing a required dimension', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches', 'import_rows', 'import_mappings', 'exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id = app_current_organization_id()) '
      'WITH CHECK (organization_id = app_current_organization_id())',
      t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;

-- Nothing here is ever deleted: batches end in a terminal status, rows are redacted, mappings
-- and exports are soft-deleted or expired.
GRANT SELECT, INSERT, UPDATE ON import_batches, import_rows, import_mappings, exports TO intuit_app;

-- Organizations with import/export housekeeping due: open batches past expiry, finished batches
-- due for redaction, ready exports past expiry, and work stuck behind a finished job.
-- Identifiers only; the cleanup runs under each organization's RLS context.
CREATE FUNCTION app_organizations_with_data_exchange_work(p_redact_before timestamptz)
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT b.organization_id FROM public.import_batches b
     WHERE (b.status IN ('awaiting_file', 'ready', 'validated', 'needs_review') AND b.expires_at <= now())
        OR (b.redacted_at IS NULL AND b.finished_at IS NOT NULL AND b.finished_at <= p_redact_before)
        OR (b.status IN ('validating', 'committing') AND b.updated_at <= now() - interval '15 minutes')
    UNION
    SELECT e.organization_id FROM public.exports e
     WHERE (e.status = 'ready' AND e.expires_at <= now())
        OR (e.status IN ('queued', 'running') AND e.created_at <= now() - interval '15 minutes')
  $$;
REVOKE ALL ON FUNCTION app_organizations_with_data_exchange_work(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizations_with_data_exchange_work(timestamptz) TO intuit_app;
