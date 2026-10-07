-- 0046_inventory — Inventory: perpetual weighted-average costing (approved 2026-10-07).
--
-- * An item becomes stock-tracked by an `inventory_items` row (it names the inventory asset and
--   cost-of-goods-sold accounts); the shared items catalog (`sales_items`) is not changed.
-- * Stock enters when a bill that carries the item posts (no goods-received-not-invoiced account in
--   v1), leaves when an invoice that carries it is issued (an additive cost-of-goods-sold journal
--   through the `inventory.cogs_posted` accounting event), and changes through stock adjustments
--   (`inventory.adjustment_posted`). Voids restore stock at the original cost.
-- * `inventory_movements` is the immutable stock ledger: every movement keeps its signed quantity,
--   its signed base value, the quantity and value after it, and its source document. Nothing is
--   updated or deleted. `inventory_balances` holds the running quantity and base value per item
--   and is changed only together with a movement.
-- * Negative stock is blocked by default (`negative_stock_policy`). The balance row carries the
--   policy it was written under so the database refuses a negative quantity when blocked.
-- * Stock adjustments are accounting source documents (`ADJ-` numbers), posted through the
--   accounting event and voided by reversing the journal.

CREATE TABLE inventory_settings (
  organization_id        uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  negative_stock_policy  text NOT NULL DEFAULT 'block' CHECK (negative_stock_policy IN ('block', 'allow')),
  -- The offset account for stock count differences (gain or loss).
  adjustment_account_id  uuid,
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  CONSTRAINT inventory_settings_adjustment_fkey FOREIGN KEY (adjustment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE inventory_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('adjustment')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE inventory_items (
  organization_id        uuid NOT NULL,
  item_id                uuid NOT NULL,
  inventory_account_id   uuid NOT NULL,
  cogs_account_id        uuid NOT NULL,
  reorder_point          numeric(28, 6) CHECK (reorder_point IS NULL OR reorder_point >= 0),
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  PRIMARY KEY (organization_id, item_id),
  CONSTRAINT inventory_items_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT inventory_items_inventory_account_fkey FOREIGN KEY (inventory_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT inventory_items_cogs_account_fkey FOREIGN KEY (cogs_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT inventory_items_distinct_accounts CHECK (inventory_account_id <> cogs_account_id)
);
CREATE INDEX inventory_items_inventory_account_idx ON inventory_items (organization_id, inventory_account_id);

CREATE TABLE inventory_balances (
  organization_id   uuid NOT NULL,
  item_id           uuid NOT NULL,
  quantity          numeric(28, 6) NOT NULL DEFAULT 0,
  value             numeric(28, 4) NOT NULL DEFAULT 0,
  -- The unit cost used when stock is issued with nothing on hand (negative stock allowed).
  last_unit_cost    numeric(28, 6) NOT NULL DEFAULT 0 CHECK (last_unit_cost >= 0),
  negative_allowed  boolean NOT NULL DEFAULT false,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (organization_id, item_id),
  CONSTRAINT inventory_balances_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_balances_not_negative CHECK (negative_allowed OR quantity >= 0),
  CONSTRAINT inventory_balances_value_sign CHECK (negative_allowed OR value >= 0)
);

CREATE TABLE inventory_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  item_id           uuid NOT NULL,
  movement_date     date NOT NULL,
  kind              text NOT NULL CHECK (kind IN
                      ('purchase', 'purchase_void', 'sale', 'sale_void', 'adjustment', 'adjustment_void')),
  -- Signed: positive adds stock.
  quantity          numeric(28, 6) NOT NULL CHECK (quantity <> 0),
  -- Signed base value of the movement (positive when stock value rises).
  value             numeric(28, 4) NOT NULL,
  quantity_after    numeric(28, 6) NOT NULL,
  value_after       numeric(28, 4) NOT NULL,
  source_module     text NOT NULL CHECK (source_module ~ '^[a-z][a-z0-9_-]*$'),
  source_type       text NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id         uuid NOT NULL,
  -- The movement this one reverses (voids only).
  reverses_id       uuid,
  journal_id        uuid,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL,
  CONSTRAINT inventory_movements_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_movements_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_movements_reverses_fkey FOREIGN KEY (reverses_id, organization_id)
    REFERENCES inventory_movements (id, organization_id),
  CONSTRAINT inventory_movements_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_movements_void_link CHECK ((kind IN ('purchase_void', 'sale_void', 'adjustment_void')) = (reverses_id IS NOT NULL))
);
-- A document moves an item once per kind: a replay never double-counts.
CREATE UNIQUE INDEX inventory_movements_source_idx
  ON inventory_movements (organization_id, kind, source_type, source_id, item_id);
CREATE UNIQUE INDEX inventory_movements_reverses_idx
  ON inventory_movements (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX inventory_movements_item_idx ON inventory_movements (organization_id, item_id, movement_date, created_at);
CREATE INDEX inventory_movements_source_lookup_idx ON inventory_movements (organization_id, source_type, source_id);

CREATE TABLE inventory_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  adjustment_date      date NOT NULL,
  reason               text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  memo                 text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  adjustment_account_id uuid NOT NULL,
  status               text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  net_value            numeric(28, 4) NOT NULL,
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
  CONSTRAINT inventory_adjustments_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_adjustments_account_fkey FOREIGN KEY (adjustment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT inventory_adjustments_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_adjustments_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT inventory_adjustments_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_adjustments_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE UNIQUE INDEX inventory_adjustments_number_idx ON inventory_adjustments (organization_id, number);
CREATE INDEX inventory_adjustments_list_idx ON inventory_adjustments (organization_id, adjustment_date DESC, id);

CREATE TABLE inventory_adjustment_lines (
  organization_id  uuid NOT NULL,
  adjustment_id    uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid NOT NULL,
  -- Signed quantity change; the cost of an increase is `unit_cost` or the current average.
  quantity_change  numeric(28, 6) NOT NULL CHECK (quantity_change <> 0),
  unit_cost        numeric(28, 6) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  value            numeric(28, 4) NOT NULL,
  movement_id      uuid NOT NULL,
  PRIMARY KEY (adjustment_id, line_no),
  CONSTRAINT inventory_adjustment_lines_adjustment_fkey FOREIGN KEY (adjustment_id, organization_id)
    REFERENCES inventory_adjustments (id, organization_id),
  CONSTRAINT inventory_adjustment_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_adjustment_lines_movement_fkey FOREIGN KEY (movement_id, organization_id)
    REFERENCES inventory_movements (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The stock ledger is immutable.
CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- A tracked item with stock history keeps its accounts and is never removed.
CREATE FUNCTION inventory_guard_item() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM inventory_movements m
                WHERE m.organization_id = OLD.organization_id AND m.item_id = OLD.item_id) THEN
      RAISE EXCEPTION 'item % has stock history and stays tracked', OLD.item_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.inventory_account_id <> OLD.inventory_account_id OR NEW.cogs_account_id <> OLD.cogs_account_id)
     AND EXISTS (SELECT 1 FROM inventory_movements m
                  WHERE m.organization_id = OLD.organization_id AND m.item_id = OLD.item_id) THEN
    RAISE EXCEPTION 'item % has stock history; its accounts cannot change', OLD.item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_items_guard
  BEFORE UPDATE OR DELETE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_item();

-- Only the void of a posted adjustment changes it.
CREATE FUNCTION inventory_guard_adjustment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'adjustments are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void adjustment % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'VOID' AND to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by_user_id'
       IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by_user_id' THEN
    RAISE EXCEPTION 'posted adjustment % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_adjustments_guard
  BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_adjustment();

CREATE TRIGGER inventory_adjustment_lines_immutable
  BEFORE UPDATE OR DELETE ON inventory_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- Truncation, RLS and grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_settings', 'inventory_number_sequences', 'inventory_items', 'inventory_balances',
    'inventory_movements', 'inventory_adjustments', 'inventory_adjustment_lines'
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
-- Un-tracking an item that never moved removes its (empty) rows.
GRANT DELETE ON inventory_items, inventory_balances TO intuit_app;

-- ---------------------------------------------------------------------------
-- Permissions and the backfill for existing organizations
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('inventory.view', 'inventory', 'View tracked items, stock levels, the stock ledger and valuation'),
  ('inventory.items.manage', 'inventory', 'Start and stop tracking stock for items'),
  ('inventory.settings.manage', 'inventory', 'Manage inventory settings (negative stock, adjustment account)'),
  ('inventory.adjustments.create', 'inventory', 'Post stock adjustments'),
  ('inventory.adjustments.void', 'inventory', 'Void stock adjustments')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE inventory_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO inventory_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('inventory.view'), ('inventory.items.manage'), ('inventory.settings.manage'),
  ('inventory.adjustments.create'), ('inventory.adjustments.void')
) AS p (key);
INSERT INTO inventory_backfill_grants (template_key, permission_key) VALUES
  ('member', 'inventory.view');

CREATE TEMPORARY TABLE inventory_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN inventory_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO inventory_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0046_inventory',
       jsonb_build_object(
         'reason', 'Inventory permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM inventory_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
