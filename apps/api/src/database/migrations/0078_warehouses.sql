-- 0078_warehouses — warehouses, a stock placement ledger and transfers (FP-29 A3/A4, ADR 0014).
--
-- Costing stays one weighted average per item (ADR 0014 AI-01). Warehouses hold QUANTITIES: every
-- stock movement writes entries to inventory_stock_entries that sum to the movement's quantity,
-- a trigger keeps inventory_stock_levels, and a deferred constraint refuses to commit unless the
-- warehouse levels of every item add up to the item balance. Existing history is backfilled into a
-- default warehouse so nothing changes for organizations that never add a second one.

CREATE TABLE inventory_warehouses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  is_default          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT inventory_warehouses_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_warehouses_default_active CHECK (NOT is_default OR status = 'ACTIVE')
);
CREATE UNIQUE INDEX inventory_warehouses_code_idx ON inventory_warehouses (organization_id, lower(code));
CREATE UNIQUE INDEX inventory_warehouses_default_idx ON inventory_warehouses (organization_id) WHERE is_default;

CREATE TABLE inventory_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  transfer_date       date NOT NULL,
  from_warehouse_id   uuid NOT NULL,
  to_warehouse_id     uuid NOT NULL,
  memo                text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  status              text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  voided_by_user_id   uuid REFERENCES users (id),
  voided_at           timestamptz,
  void_reason         text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT inventory_transfers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_transfers_from_fkey FOREIGN KEY (from_warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id),
  CONSTRAINT inventory_transfers_to_fkey FOREIGN KEY (to_warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id),
  CONSTRAINT inventory_transfers_distinct CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT inventory_transfers_void CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL) AND (status <> 'VOID' OR void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX inventory_transfers_number_idx ON inventory_transfers (organization_id, number);
CREATE INDEX inventory_transfers_list_idx ON inventory_transfers (organization_id, transfer_date DESC, id);

CREATE TABLE inventory_transfer_lines (
  organization_id  uuid NOT NULL,
  transfer_id      uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (transfer_id, line_no),
  CONSTRAINT inventory_transfer_lines_transfer_fkey FOREIGN KEY (transfer_id, organization_id)
    REFERENCES inventory_transfers (id, organization_id),
  CONSTRAINT inventory_transfer_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id)
);
CREATE UNIQUE INDEX inventory_transfer_lines_item_idx ON inventory_transfer_lines (transfer_id, item_id);

-- The placement ledger: signed quantities by (item, warehouse). Append-only.
CREATE TABLE inventory_stock_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  item_id             uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  quantity            numeric(28, 6) NOT NULL CHECK (quantity <> 0),
  entry_kind          text NOT NULL CHECK (entry_kind IN ('movement', 'transfer', 'backfill')),
  movement_id         uuid,
  transfer_id         uuid,
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT inventory_stock_entries_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_stock_entries_warehouse_fkey FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id),
  CONSTRAINT inventory_stock_entries_movement_fkey FOREIGN KEY (movement_id, organization_id)
    REFERENCES inventory_movements (id, organization_id),
  CONSTRAINT inventory_stock_entries_transfer_fkey FOREIGN KEY (transfer_id, organization_id)
    REFERENCES inventory_transfers (id, organization_id),
  CONSTRAINT inventory_stock_entries_source CHECK (
    (entry_kind = 'movement' AND movement_id IS NOT NULL AND transfer_id IS NULL)
    OR (entry_kind = 'transfer' AND transfer_id IS NOT NULL AND movement_id IS NULL)
    OR (entry_kind = 'backfill' AND movement_id IS NULL AND transfer_id IS NULL))
);
CREATE INDEX inventory_stock_entries_item_idx ON inventory_stock_entries (organization_id, item_id, warehouse_id);
CREATE INDEX inventory_stock_entries_movement_idx ON inventory_stock_entries (organization_id, movement_id)
  WHERE movement_id IS NOT NULL;
CREATE INDEX inventory_stock_entries_transfer_idx ON inventory_stock_entries (organization_id, transfer_id)
  WHERE transfer_id IS NOT NULL;
CREATE TRIGGER inventory_stock_entries_immutable BEFORE UPDATE OR DELETE ON inventory_stock_entries
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

CREATE TABLE inventory_stock_levels (
  organization_id  uuid NOT NULL,
  item_id          uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, item_id, warehouse_id),
  CONSTRAINT inventory_stock_levels_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_stock_levels_warehouse_fkey FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id)
);
CREATE INDEX inventory_stock_levels_warehouse_idx ON inventory_stock_levels (organization_id, warehouse_id);

-- Entries drive the levels. A level below zero is refused unless the item's balance allows negative
-- stock (the same policy flag the item balance carries).
CREATE FUNCTION inventory_apply_stock_entry() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  new_quantity numeric(28, 6);
  allowed boolean;
BEGIN
  INSERT INTO inventory_stock_levels AS l (organization_id, item_id, warehouse_id, quantity)
  VALUES (NEW.organization_id, NEW.item_id, NEW.warehouse_id, NEW.quantity)
  ON CONFLICT (organization_id, item_id, warehouse_id)
  DO UPDATE SET quantity = l.quantity + EXCLUDED.quantity
  RETURNING quantity INTO new_quantity;
  IF new_quantity < 0 THEN
    SELECT negative_allowed INTO allowed FROM inventory_balances
     WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
    IF NOT COALESCE(allowed, false) THEN
      RAISE EXCEPTION 'warehouse stock of item % would be negative (%)', NEW.item_id, new_quantity
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_entries_apply AFTER INSERT ON inventory_stock_entries
  FOR EACH ROW EXECUTE FUNCTION inventory_apply_stock_entry();

-- At commit, the warehouse levels of an item must add up to its balance (and the other way round).
CREATE FUNCTION inventory_check_levels() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  levels numeric(28, 6);
  balance numeric(28, 6);
BEGIN
  SELECT coalesce(sum(quantity), 0) INTO levels FROM inventory_stock_levels
   WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
  SELECT quantity INTO balance FROM inventory_balances
   WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
  IF levels IS DISTINCT FROM coalesce(balance, 0) THEN
    RAISE EXCEPTION 'warehouse stock of item % (%) does not add up to its balance (%)',
      NEW.item_id, levels, coalesce(balance, 0) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER inventory_balances_levels_check AFTER INSERT OR UPDATE ON inventory_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_check_levels();
CREATE CONSTRAINT TRIGGER inventory_levels_balance_check AFTER INSERT OR UPDATE ON inventory_stock_levels
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_check_levels();

-- Which warehouse a draft document will use when its stock moves (invoice, bill, vendor credit).
CREATE TABLE inventory_document_locations (
  organization_id  uuid NOT NULL,
  document_type    text NOT NULL CHECK (document_type IN ('invoice', 'bill', 'vendor_credit')),
  document_id      uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  set_by_user_id   uuid REFERENCES users (id),
  set_at           timestamptz NOT NULL,
  PRIMARY KEY (document_type, document_id),
  CONSTRAINT inventory_document_locations_warehouse_fkey FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id)
);

-- Adjustments, customer returns and counts name their warehouse (NULL = default / automatic).
ALTER TABLE inventory_adjustments ADD COLUMN warehouse_id uuid;
ALTER TABLE inventory_adjustments ADD CONSTRAINT inventory_adjustments_warehouse_fkey
  FOREIGN KEY (warehouse_id, organization_id) REFERENCES inventory_warehouses (id, organization_id);
ALTER TABLE inventory_returns ADD COLUMN warehouse_id uuid;
ALTER TABLE inventory_returns ADD CONSTRAINT inventory_returns_warehouse_fkey
  FOREIGN KEY (warehouse_id, organization_id) REFERENCES inventory_warehouses (id, organization_id);
ALTER TABLE inventory_counts ADD COLUMN warehouse_id uuid;
ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_warehouse_fkey
  FOREIGN KEY (warehouse_id, organization_id) REFERENCES inventory_warehouses (id, organization_id);

ALTER TABLE inventory_number_sequences DROP CONSTRAINT inventory_number_sequences_document_type_check;
ALTER TABLE inventory_number_sequences ADD CONSTRAINT inventory_number_sequences_document_type_check
  CHECK (document_type IN ('adjustment', 'return', 'count', 'transfer'));

-- Transfers never change after posting except for their void.
CREATE FUNCTION inventory_guard_transfer() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfers are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void transfer % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.number, NEW.transfer_date, NEW.from_warehouse_id, NEW.to_warehouse_id)
     IS DISTINCT FROM (OLD.number, OLD.transfer_date, OLD.from_warehouse_id, OLD.to_warehouse_id) THEN
    RAISE EXCEPTION 'the content of transfer % is fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_transfers_guard BEFORE UPDATE OR DELETE ON inventory_transfers
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_transfer();
CREATE TRIGGER inventory_transfer_lines_immutable BEFORE UPDATE OR DELETE ON inventory_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- The default warehouse keeps its role; a warehouse with stock is never archived.
CREATE FUNCTION inventory_guard_warehouse() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warehouses are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'ARCHIVED' AND OLD.status <> 'ARCHIVED' AND EXISTS (
       SELECT 1 FROM inventory_stock_levels l
        WHERE l.organization_id = OLD.organization_id AND l.warehouse_id = OLD.id AND l.quantity <> 0) THEN
    RAISE EXCEPTION 'warehouse % still holds stock and cannot be archived', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_warehouses_guard BEFORE UPDATE OR DELETE ON inventory_warehouses
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_warehouse();

-- ---------------------------------------------------------------------------------------------
-- Backfill: a default warehouse per organization with tracked items; every existing movement is
-- placed in it, and any difference between the movements and the balance becomes one 'backfill'
-- entry so the totals match exactly before the checks above start to apply.
-- ---------------------------------------------------------------------------------------------

INSERT INTO inventory_warehouses (organization_id, code, name, is_default, created_at, updated_at)
SELECT DISTINCT i.organization_id, 'MAIN', 'Main warehouse', true, now(), now()
  FROM inventory_items i;

ALTER TABLE inventory_stock_entries DISABLE TRIGGER inventory_stock_entries_apply;

INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind,
                                     movement_id, created_by_user_id, created_at)
SELECT m.organization_id, m.item_id, w.id, m.quantity, 'movement', m.id, m.created_by_user_id, m.created_at
  FROM inventory_movements m
  JOIN inventory_warehouses w ON w.organization_id = m.organization_id AND w.is_default;

INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind, created_at)
SELECT b.organization_id, b.item_id, w.id, b.quantity - coalesce(e.total, 0), 'backfill', now()
  FROM inventory_balances b
  JOIN inventory_warehouses w ON w.organization_id = b.organization_id AND w.is_default
  LEFT JOIN (SELECT organization_id, item_id, sum(quantity) AS total
               FROM inventory_stock_entries GROUP BY organization_id, item_id) e
         ON e.organization_id = b.organization_id AND e.item_id = b.item_id
 WHERE b.quantity - coalesce(e.total, 0) <> 0;

INSERT INTO inventory_stock_levels (organization_id, item_id, warehouse_id, quantity)
SELECT organization_id, item_id, warehouse_id, sum(quantity)
  FROM inventory_stock_entries
 GROUP BY organization_id, item_id, warehouse_id;

ALTER TABLE inventory_stock_entries ENABLE TRIGGER inventory_stock_entries_apply;

-- Run the deferred level checks now (they must pass for the backfill to be accepted) so no trigger
-- events are pending when the tables are altered below.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- Posted and cancelled counts are final; the guard is lifted only for this one backfill.
ALTER TABLE inventory_counts DISABLE TRIGGER inventory_counts_guard;
UPDATE inventory_counts c SET warehouse_id = w.id
  FROM inventory_warehouses w WHERE w.organization_id = c.organization_id AND w.is_default;
ALTER TABLE inventory_counts ENABLE TRIGGER inventory_counts_guard;

-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_warehouses', 'inventory_transfers', 'inventory_transfer_lines',
    'inventory_stock_entries', 'inventory_stock_levels', 'inventory_document_locations'
  ] LOOP
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

GRANT SELECT, INSERT, UPDATE ON inventory_warehouses, inventory_transfers, inventory_stock_levels TO intuit_app;
GRANT SELECT, INSERT ON inventory_transfer_lines, inventory_stock_entries TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_document_locations TO intuit_app;
