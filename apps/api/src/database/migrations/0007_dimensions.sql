-- Intuit 2.0 — Phase 3A, S2: dimensions (Decisions 3, 16, 55, 67, 78, 84, 85, 86).
--
--   * accounting_dimension_types: generic, organization-defined types (Branch, Department,
--     Project, Cost Center, custom ...). No type is hard-coded. Each type is required or optional
--     and has an account-classification scope (account natures and/or Decision 53 subtypes).
--     A required type applies to a manual journal line only when the line's account is in its
--     scope; an empty scope enforces nothing (Decision 84). No per-account rules in Phase 3A.
--   * accounting_dimension_values: values of a type.
--   * accounting_journal_line_dimensions: at most one value per type per journal line.
--     Assignments change only while the journal is a draft; posted assignments are immutable.
--     Dimensions never take part in balancing.
--   * The posting guard rejects manual journals missing a required dimension (defence in depth
--     behind the submission and posting checks of Decision 86). System and event journals follow
--     the rules of their originating module (Decision 78).

CREATE TABLE accounting_dimension_types (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES accounting_settings (organization_id),
  code                   text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name                   text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description            text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  is_required            boolean NOT NULL DEFAULT false,
  scope_account_types    text[] NOT NULL DEFAULT '{}' CHECK (
    scope_account_types <@ ARRAY['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']::text[]),
  scope_account_subtypes text[] NOT NULL DEFAULT '{}' CHECK (
    scope_account_subtypes <@ ARRAY['BANK', 'CASH', 'ACCOUNTS_RECEIVABLE', 'OTHER_CURRENT_ASSET',
      'FIXED_ASSET', 'OTHER_ASSET', 'ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY',
      'LONG_TERM_LIABILITY', 'EQUITY', 'OPERATING_REVENUE', 'OTHER_INCOME', 'COST_OF_SALES',
      'OPERATING_EXPENSE', 'OTHER_EXPENSE']::text[]),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_by_user_id    uuid REFERENCES users (id),
  archived_at            timestamptz,
  CONSTRAINT accounting_dimension_types_organization_code_key UNIQUE (organization_id, code),
  CONSTRAINT accounting_dimension_types_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_dimension_types_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX accounting_dimension_types_organization_name_idx
  ON accounting_dimension_types (organization_id, lower(name));
CREATE TRIGGER accounting_dimension_types_touch_updated_at BEFORE UPDATE ON accounting_dimension_types
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE accounting_dimension_values (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  dimension_type_id   uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_by_user_id uuid REFERENCES users (id),
  archived_at         timestamptz,
  CONSTRAINT accounting_dimension_values_type_fkey FOREIGN KEY (dimension_type_id, organization_id)
    REFERENCES accounting_dimension_types (id, organization_id),
  CONSTRAINT accounting_dimension_values_type_code_key UNIQUE (dimension_type_id, code),
  CONSTRAINT accounting_dimension_values_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_dimension_values_id_type_organization_key UNIQUE (id, dimension_type_id, organization_id),
  CONSTRAINT accounting_dimension_values_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX accounting_dimension_values_type_name_idx
  ON accounting_dimension_values (dimension_type_id, lower(name));
CREATE TRIGGER accounting_dimension_values_touch_updated_at BEFORE UPDATE ON accounting_dimension_values
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

ALTER TABLE accounting_journal_lines ADD CONSTRAINT accounting_journal_lines_id_organization_key
  UNIQUE (id, organization_id);

-- One value per dimension type per journal line (primary key). The value must belong to the type
-- and both to the line's organization (composite keys).
CREATE TABLE accounting_journal_line_dimensions (
  organization_id    uuid NOT NULL,
  journal_line_id    uuid NOT NULL,
  dimension_type_id  uuid NOT NULL,
  dimension_value_id uuid NOT NULL,
  PRIMARY KEY (journal_line_id, dimension_type_id),
  CONSTRAINT accounting_journal_line_dimensions_line_fkey FOREIGN KEY (journal_line_id, organization_id)
    REFERENCES accounting_journal_lines (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT accounting_journal_line_dimensions_value_fkey
    FOREIGN KEY (dimension_value_id, dimension_type_id, organization_id)
    REFERENCES accounting_dimension_values (id, dimension_type_id, organization_id)
);
CREATE INDEX accounting_journal_line_dimensions_value_idx
  ON accounting_journal_line_dimensions (organization_id, dimension_value_id);

-- Assignments change only while their journal is a draft (posted assignments are immutable).
-- A cascade from a deleted draft line finds no line any more; line deletion is itself guarded.
CREATE FUNCTION accounting_guard_journal_line_dimension() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_status text;
  v_row accounting_journal_line_dimensions;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT j.status INTO v_status
    FROM accounting_journal_lines l
    JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
   WHERE l.id = v_row.journal_line_id AND l.organization_id = v_row.organization_id;
  IF v_status = 'DRAFT' OR (TG_OP = 'DELETE' AND v_status IS NULL) THEN
    RETURN v_row;
  END IF;
  RAISE EXCEPTION 'dimension assignments of % journal lines cannot be modified', coalesce(v_status, 'missing')
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER accounting_journal_line_dimensions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_journal_line_dimensions
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_journal_line_dimension();
CREATE TRIGGER accounting_journal_line_dimensions_no_truncate BEFORE TRUNCATE ON accounting_journal_line_dimensions
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Posting guard: adds the required-dimension check for manual journals
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
  FOREACH t IN ARRAY ARRAY[
    'accounting_dimension_types', 'accounting_dimension_values', 'accounting_journal_line_dimensions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id = app_current_organization_id()) '
      'WITH CHECK (organization_id = app_current_organization_id())',
      t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;

-- Types and values are archived, never deleted.
GRANT SELECT, INSERT, UPDATE ON accounting_dimension_types, accounting_dimension_values TO intuit_app;
GRANT SELECT, INSERT, DELETE ON accounting_journal_line_dimensions TO intuit_app;
