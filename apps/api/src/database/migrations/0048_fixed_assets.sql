-- 0048_fixed_assets — Fixed assets v1 (approved 2026-10-07): cost model, straight-line
-- depreciation, register, categories, acquisition, capitalization, accumulated depreciation,
-- disposal with gain or loss, category transfers, the depreciation schedule and journals.
-- No revaluation.
--
-- * A category names the cost, accumulated-depreciation and depreciation-expense accounts and a
--   default useful life. An asset (`FA-`) is capitalized at its cost in the base currency, with a
--   salvage value and a life in months; depreciation is straight line by month, the in-service
--   month counting as the first.
-- * Acquisition posts Dr cost / Cr the funding account through the `fixed_assets.acquisition_posted`
--   accounting event, or only registers an asset whose cost is already in the ledger (for
--   example from a bill) when `alreadyInLedger` is set; the register-to-ledger reconciliation shows
--   any difference.
-- * A depreciation run (`DEP-`) books, as of a month end, the difference between the schedule and
--   what each asset has booked so far, in one journal by category (`fixed_assets.depreciation_posted`).
--   Only the latest run can be voided.
-- * A disposal books catch-up depreciation to the end of the month before the disposal, removes
--   cost and accumulated depreciation, takes the proceeds and posts the gain or loss to the
--   organization's gain/loss account (`fixed_assets.disposal_posted`). A transfer re-classes an
--   asset to another category, moving cost and accumulated depreciation when the accounts differ
--   (`fixed_assets.transfer_posted`).
-- * `fixed_asset_entries` is the immutable ledger of every change to an asset's cost and
--   accumulated depreciation; the asset row keeps the running totals.

CREATE TABLE fixed_asset_settings (
  organization_id        uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  -- Where the gain or loss on a disposal is booked.
  gain_loss_account_id   uuid,
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  CONSTRAINT fixed_asset_settings_account_fkey FOREIGN KEY (gain_loss_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE fixed_asset_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('asset', 'run')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE fixed_asset_categories (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES accounting_settings (organization_id),
  name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  cost_account_id           uuid NOT NULL,
  accumulated_account_id    uuid NOT NULL,
  expense_account_id        uuid NOT NULL,
  default_life_months       integer NOT NULL CHECK (default_life_months BETWEEN 1 AND 1200),
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id        uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL,
  updated_by_user_id        uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL,
  CONSTRAINT fixed_asset_categories_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT fixed_asset_categories_cost_fkey FOREIGN KEY (cost_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT fixed_asset_categories_accumulated_fkey FOREIGN KEY (accumulated_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT fixed_asset_categories_expense_fkey FOREIGN KEY (expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT fixed_asset_categories_distinct_accounts CHECK (
    cost_account_id <> accumulated_account_id AND cost_account_id <> expense_account_id
    AND accumulated_account_id <> expense_account_id)
);
CREATE UNIQUE INDEX fixed_asset_categories_name_idx
  ON fixed_asset_categories (organization_id, lower(name));

CREATE TABLE fixed_assets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number                    text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description               text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category_id               uuid NOT NULL,
  acquisition_date          date NOT NULL,
  in_service_date           date NOT NULL,
  cost                      numeric(28, 4) NOT NULL CHECK (cost > 0),
  salvage_value             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  life_months               integer NOT NULL CHECK (life_months BETWEEN 1 AND 1200),
  accumulated_depreciation  numeric(28, 4) NOT NULL DEFAULT 0 CHECK (accumulated_depreciation >= 0),
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISPOSED')),
  location                  text NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  custodian                 text NOT NULL DEFAULT '' CHECK (length(custodian) <= 200),
  serial_number             text NOT NULL DEFAULT '' CHECK (length(serial_number) <= 100),
  acquisition_journal_id    uuid,
  in_ledger                 boolean NOT NULL DEFAULT false,
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id        uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL,
  updated_by_user_id        uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL,
  CONSTRAINT fixed_assets_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT fixed_assets_category_fkey FOREIGN KEY (category_id, organization_id)
    REFERENCES fixed_asset_categories (id, organization_id),
  CONSTRAINT fixed_assets_journal_fkey FOREIGN KEY (acquisition_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_assets_salvage_within_cost CHECK (salvage_value <= cost),
  CONSTRAINT fixed_assets_depreciation_within_cost CHECK (accumulated_depreciation <= cost - salvage_value),
  CONSTRAINT fixed_assets_in_service_after_acquisition CHECK (in_service_date >= acquisition_date)
);
CREATE UNIQUE INDEX fixed_assets_number_idx ON fixed_assets (organization_id, number);
CREATE INDEX fixed_assets_list_idx ON fixed_assets (organization_id, status, lower(name), id);
CREATE INDEX fixed_assets_category_idx ON fixed_assets (organization_id, category_id);

CREATE TABLE fixed_asset_depreciation_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  month_end            date NOT NULL,
  status               text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  total_amount         numeric(28, 4) NOT NULL CHECK (total_amount >= 0),
  asset_count          integer NOT NULL CHECK (asset_count >= 0),
  journal_id           uuid,
  accounting_event_id  uuid,
  voided_by_user_id    uuid REFERENCES users (id),
  voided_at            timestamptz,
  void_reason          text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id      uuid,
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  CONSTRAINT fixed_asset_runs_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT fixed_asset_runs_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_asset_runs_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT fixed_asset_runs_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_asset_runs_month_end CHECK (month_end = (date_trunc('month', month_end) + interval '1 month - 1 day')::date),
  CONSTRAINT fixed_asset_runs_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL)))
);
CREATE UNIQUE INDEX fixed_asset_runs_number_idx ON fixed_asset_depreciation_runs (organization_id, number);
-- One live run per month end.
CREATE UNIQUE INDEX fixed_asset_runs_month_idx
  ON fixed_asset_depreciation_runs (organization_id, month_end) WHERE status = 'POSTED';

CREATE TABLE fixed_asset_disposals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  asset_id                 uuid NOT NULL,
  disposal_date            date NOT NULL,
  proceeds                 numeric(28, 4) NOT NULL DEFAULT 0 CHECK (proceeds >= 0),
  proceeds_account_id      uuid,
  catchup_depreciation     numeric(28, 4) NOT NULL DEFAULT 0 CHECK (catchup_depreciation >= 0),
  cost                     numeric(28, 4) NOT NULL,
  accumulated_depreciation numeric(28, 4) NOT NULL,
  gain_loss                numeric(28, 4) NOT NULL,
  memo                     text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  status                   text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  journal_id               uuid,
  accounting_event_id      uuid,
  voided_by_user_id        uuid REFERENCES users (id),
  voided_at                timestamptz,
  void_reason              text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id          uuid,
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id       uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL,
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL,
  CONSTRAINT fixed_asset_disposals_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT fixed_asset_disposals_asset_fkey FOREIGN KEY (asset_id, organization_id)
    REFERENCES fixed_assets (id, organization_id),
  CONSTRAINT fixed_asset_disposals_account_fkey FOREIGN KEY (proceeds_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT fixed_asset_disposals_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_asset_disposals_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT fixed_asset_disposals_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_asset_disposals_proceeds_account CHECK (proceeds = 0 OR proceeds_account_id IS NOT NULL),
  CONSTRAINT fixed_asset_disposals_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR void_reason IS NOT NULL))
);
-- An asset is disposed of once at a time.
CREATE UNIQUE INDEX fixed_asset_disposals_asset_idx
  ON fixed_asset_disposals (asset_id) WHERE status = 'POSTED';

CREATE TABLE fixed_asset_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  asset_id                 uuid NOT NULL,
  transfer_date            date NOT NULL,
  from_category_id         uuid NOT NULL,
  to_category_id           uuid NOT NULL,
  from_location            text NOT NULL DEFAULT '',
  to_location              text NOT NULL DEFAULT '',
  cost                     numeric(28, 4) NOT NULL,
  accumulated_depreciation numeric(28, 4) NOT NULL,
  memo                     text NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  journal_id               uuid,
  accounting_event_id      uuid,
  created_by_user_id       uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL,
  CONSTRAINT fixed_asset_transfers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT fixed_asset_transfers_asset_fkey FOREIGN KEY (asset_id, organization_id)
    REFERENCES fixed_assets (id, organization_id),
  CONSTRAINT fixed_asset_transfers_from_fkey FOREIGN KEY (from_category_id, organization_id)
    REFERENCES fixed_asset_categories (id, organization_id),
  CONSTRAINT fixed_asset_transfers_to_fkey FOREIGN KEY (to_category_id, organization_id)
    REFERENCES fixed_asset_categories (id, organization_id),
  CONSTRAINT fixed_asset_transfers_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT fixed_asset_transfers_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id)
);
CREATE INDEX fixed_asset_transfers_asset_idx ON fixed_asset_transfers (organization_id, asset_id, transfer_date);

-- The immutable ledger of every change to an asset's cost and accumulated depreciation.
CREATE TABLE fixed_asset_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  asset_id            uuid NOT NULL,
  entry_date          date NOT NULL,
  kind                text NOT NULL CHECK (kind IN
                        ('acquisition', 'depreciation', 'depreciation_void', 'disposal', 'disposal_void')),
  -- Signed changes: cost, and accumulated depreciation (positive adds depreciation).
  cost_change         numeric(28, 4) NOT NULL,
  accumulated_change  numeric(28, 4) NOT NULL,
  source_type         text NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id           uuid NOT NULL,
  journal_id          uuid,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT fixed_asset_entries_asset_fkey FOREIGN KEY (asset_id, organization_id)
    REFERENCES fixed_assets (id, organization_id),
  CONSTRAINT fixed_asset_entries_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
CREATE INDEX fixed_asset_entries_asset_idx ON fixed_asset_entries (organization_id, asset_id, entry_date, created_at);
CREATE INDEX fixed_asset_entries_source_idx ON fixed_asset_entries (organization_id, source_type, source_id);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER fixed_asset_entries_immutable
  BEFORE UPDATE OR DELETE ON fixed_asset_entries
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER fixed_asset_transfers_immutable
  BEFORE UPDATE OR DELETE ON fixed_asset_transfers
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- An asset is never deleted. Its terms are fixed once capitalized; descriptive fields, the running
-- depreciation, the status and the category (through a transfer) change.
CREATE FUNCTION fixed_assets_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fixed assets are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.acquisition_date, NEW.in_service_date, NEW.cost,
      NEW.salvage_value, NEW.life_months, NEW.acquisition_journal_id, NEW.in_ledger, NEW.created_at,
      NEW.created_by_user_id)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.acquisition_date, OLD.in_service_date, OLD.cost,
      OLD.salvage_value, OLD.life_months, OLD.acquisition_journal_id, OLD.in_ledger, OLD.created_at,
      OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'the terms of fixed asset % are fixed once capitalized', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'DISPOSED' AND NEW.status = 'DISPOSED'
     AND (NEW.accumulated_depreciation, NEW.category_id) IS DISTINCT FROM (OLD.accumulated_depreciation, OLD.category_id) THEN
    RAISE EXCEPTION 'disposed fixed asset % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixed_assets_guard
  BEFORE UPDATE OR DELETE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION fixed_assets_guard();

CREATE FUNCTION fixed_asset_documents_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted (%)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
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
CREATE TRIGGER fixed_asset_runs_guard
  BEFORE UPDATE OR DELETE ON fixed_asset_depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION fixed_asset_documents_guard();
CREATE TRIGGER fixed_asset_disposals_guard
  BEFORE UPDATE OR DELETE ON fixed_asset_disposals
  FOR EACH ROW EXECUTE FUNCTION fixed_asset_documents_guard();

-- A category in use keeps its accounts.
CREATE FUNCTION fixed_asset_categories_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'categories are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.cost_account_id, NEW.accumulated_account_id, NEW.expense_account_id)
     IS DISTINCT FROM (OLD.cost_account_id, OLD.accumulated_account_id, OLD.expense_account_id)
     AND EXISTS (SELECT 1 FROM fixed_assets a
                  WHERE a.organization_id = OLD.organization_id AND a.category_id = OLD.id) THEN
    RAISE EXCEPTION 'category % has assets; its accounts cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixed_asset_categories_guard
  BEFORE UPDATE OR DELETE ON fixed_asset_categories
  FOR EACH ROW EXECUTE FUNCTION fixed_asset_categories_guard();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fixed_asset_settings', 'fixed_asset_number_sequences', 'fixed_asset_categories', 'fixed_assets',
    'fixed_asset_depreciation_runs', 'fixed_asset_disposals', 'fixed_asset_transfers',
    'fixed_asset_entries'
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

INSERT INTO permissions (key, module, description) VALUES
  ('fixed_assets.view', 'fixed_assets', 'View the fixed asset register, categories, schedules and reports'),
  ('fixed_assets.manage', 'fixed_assets', 'Manage categories and settings, register and edit assets, and transfer them'),
  ('fixed_assets.depreciate', 'fixed_assets', 'Run depreciation'),
  ('fixed_assets.dispose', 'fixed_assets', 'Dispose of fixed assets'),
  ('fixed_assets.void', 'fixed_assets', 'Void depreciation runs and disposals')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE fixed_asset_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO fixed_asset_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('fixed_assets.view'), ('fixed_assets.manage'), ('fixed_assets.depreciate'),
  ('fixed_assets.dispose'), ('fixed_assets.void')
) AS p (key);
INSERT INTO fixed_asset_backfill_grants (template_key, permission_key) VALUES
  ('member', 'fixed_assets.view');

CREATE TEMPORARY TABLE fixed_asset_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN fixed_asset_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO fixed_asset_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0048_fixed_assets',
       jsonb_build_object(
         'reason', 'Fixed asset permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM fixed_asset_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
