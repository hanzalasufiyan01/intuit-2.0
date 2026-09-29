-- 0016_opening_balances — Phase 3A S8: opening balances / conversion balances.
-- Decisions 14, 27, 68, 69, 73; S8-01 to S8-23 (ADR 0003).
--
-- * accounting_settings.conversion_date: the explicit conversion date (S8-04, S8-13).
-- * An opening batch (DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED, S8-03) holds the balances
--   entered for the conversion; posting creates one system journal per currency through the
--   existing system-journal path (source accounting/opening_balance/<batch id>, S8-10, S8-20).
--   There is no batch-to-journal link table: the journal source reference is the relationship.
-- * Database protections: lines change only while their batch is a DRAFT; state transitions are
--   constrained; POSTED batches are immutable except the move to REVERSED; REVERSED batches are
--   immutable; only DRAFT batches can be deleted (S8-18).
-- * The S6 import/export domain lists and the S5 link types gain the opening-balance entries
--   (S8-16, S8-17).

ALTER TABLE accounting_settings ADD COLUMN conversion_date date;

-- ---------------------------------------------------------------------------
-- Opening batches
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_opening_balance_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status               text NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED')),
  conversion_date      date NOT NULL,
  -- S8-04: the opening journals are dated the day before the conversion date.
  opening_date         date NOT NULL,
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  notes                text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  approval_request_id  uuid,
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  submitted_by_user_id uuid REFERENCES users (id),
  submitted_at         timestamptz,
  posted_by_user_id    uuid REFERENCES users (id),
  posted_at            timestamptz,
  reversed_by_user_id  uuid REFERENCES users (id),
  reversed_at          timestamptz,
  reversal_reason      text CHECK (length(reversal_reason) <= 500),
  CONSTRAINT accounting_opening_balance_batches_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT accounting_opening_balance_batches_approval_fkey
    FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT accounting_opening_balance_batches_opening_date
    CHECK (opening_date = conversion_date - 1),
  CONSTRAINT accounting_opening_balance_batches_state_consistency CHECK (
    (status <> 'PENDING_APPROVAL' OR (approval_request_id IS NOT NULL AND submitted_at IS NOT NULL))
    AND ((status IN ('POSTED', 'REVERSED')) = (posted_at IS NOT NULL AND posted_by_user_id IS NOT NULL))
    AND ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversed_by_user_id IS NOT NULL
                                  AND reversal_reason IS NOT NULL)))
);
-- One open batch per organization (S8-03): a new batch needs the previous one reversed.
CREATE UNIQUE INDEX accounting_opening_balance_batches_one_open_idx
  ON accounting_opening_balance_batches (organization_id)
  WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED');
CREATE INDEX accounting_opening_balance_batches_org_created_idx
  ON accounting_opening_balance_batches (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Opening lines: amounts in the account's currency; explicit base amount optional (S8-06).
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_opening_balance_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  batch_id        uuid NOT NULL,
  line_number     integer NOT NULL CHECK (line_number BETWEEN 1 AND 100000),
  account_id      uuid NOT NULL,
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  debit           numeric(28, 4) CHECK (debit > 0),
  credit          numeric(28, 4) CHECK (credit > 0),
  base_amount     numeric(28, 4) CHECK (base_amount > 0),
  -- Line-level dimension assignments [{dimensionTypeId, dimensionValueId}], validated by the
  -- service with the journal rules; they become journal-line dimensions at posting.
  dimensions      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dimensions) = 'array'),
  CONSTRAINT accounting_opening_balance_lines_one_side CHECK ((debit IS NULL) <> (credit IS NULL)),
  CONSTRAINT accounting_opening_balance_lines_batch_fkey FOREIGN KEY (batch_id, organization_id)
    REFERENCES accounting_opening_balance_batches (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT accounting_opening_balance_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT accounting_opening_balance_lines_number_key UNIQUE (batch_id, line_number)
);
CREATE INDEX accounting_opening_balance_lines_account_idx
  ON accounting_opening_balance_lines (organization_id, account_id);

-- ---------------------------------------------------------------------------
-- Protections
-- ---------------------------------------------------------------------------

CREATE FUNCTION accounting_guard_opening_balance_batch() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- S8-18: only drafts may be deleted; submitted, posted and reversed history never.
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only draft opening batches can be deleted (batch %).', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Opening batch identity cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'A reversed opening batch is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'POSTED' THEN
    -- Only the move to REVERSED, touching nothing but the reversal columns.
    IF NEW.status <> 'REVERSED'
       OR (NEW.conversion_date, NEW.opening_date, NEW.notes, NEW.approval_request_id,
           NEW.submitted_by_user_id, NEW.submitted_at, NEW.posted_by_user_id, NEW.posted_at)
          IS DISTINCT FROM
          (OLD.conversion_date, OLD.opening_date, OLD.notes, OLD.approval_request_id,
           OLD.submitted_by_user_id, OLD.submitted_at, OLD.posted_by_user_id, OLD.posted_at) THEN
      RAISE EXCEPTION 'A posted opening batch can only be reversed.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- DRAFT and PENDING_APPROVAL: the allowed transitions (S8-03).
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'POSTED'))) THEN
    RAISE EXCEPTION 'Invalid opening batch transition % -> %.', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The dates follow the conversion date only while nothing has been submitted.
  IF (NEW.conversion_date, NEW.opening_date) IS DISTINCT FROM (OLD.conversion_date, OLD.opening_date)
     AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'The opening date of a submitted batch cannot change.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_opening_balance_batches_guard
  BEFORE UPDATE OR DELETE ON accounting_opening_balance_batches
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_opening_balance_batch();
CREATE TRIGGER accounting_opening_balance_batches_no_truncate
  BEFORE TRUNCATE ON accounting_opening_balance_batches
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- Lines change only while their batch is a draft. (During a draft's deletion the batch row is
-- already gone when its lines cascade, which is allowed.)
CREATE FUNCTION accounting_guard_opening_balance_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_batch  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION 'Opening lines cannot move between batches.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM accounting_opening_balance_batches WHERE id = v_batch;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Opening lines can only change while the batch is a draft.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER accounting_opening_balance_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_opening_balance_line();
CREATE TRIGGER accounting_opening_balance_lines_no_truncate
  BEFORE TRUNCATE ON accounting_opening_balance_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_opening_balance_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_opening_balance_lines   ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_opening_balance_batches_tenant ON accounting_opening_balance_batches FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY accounting_opening_balance_lines_tenant ON accounting_opening_balance_lines FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON accounting_opening_balance_batches, accounting_opening_balance_lines FROM PUBLIC;
-- DELETE is granted for draft deletion and draft line replacement; the triggers above refuse
-- anything else.
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_opening_balance_batches TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_opening_balance_lines TO intuit_app;

-- ---------------------------------------------------------------------------
-- S6 domains and S5 attachment target
-- ---------------------------------------------------------------------------

ALTER TABLE import_batches DROP CONSTRAINT import_batches_domain_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances'));
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_domain_check;
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'party_contacts', 'dimension_values', 'exchange_rates',
  'manual_journals', 'opening_balances'));
ALTER TABLE exports DROP CONSTRAINT exports_domain_check;
ALTER TABLE exports ADD CONSTRAINT exports_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors', 'opening_balances'));

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch'));
