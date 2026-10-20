-- 0079_lots_serials — lot, serial and expiry tracking on top of the warehouse placement ledger
-- (FP-29 A6, ADR 0014 AI-07).
--
-- An item's tracking mode is none | lot | serial (serial = a lot of quantity one), with an optional
-- expiry flag. Lots carry quantities only: cost stays one average per item (AI-01). Every stock entry
-- of a lot- or serial-tracked item names its lot; the lot levels per warehouse must add up to the
-- warehouse level, checked at commit like the warehouse levels themselves. Lots never go negative,
-- whatever the negative-stock policy says, and a serial exists at most once.

ALTER TABLE inventory_items
  ADD COLUMN tracking_mode text NOT NULL DEFAULT 'none' CHECK (tracking_mode IN ('none', 'lot', 'serial')),
  ADD COLUMN expiry_tracked boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT inventory_items_expiry_needs_lots CHECK (tracking_mode <> 'none' OR NOT expiry_tracked);

-- The tracking mode is fixed once the item has stock history (it cannot be re-derived afterwards).
CREATE OR REPLACE FUNCTION inventory_guard_item() RETURNS trigger
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
  IF (NEW.tracking_mode <> OLD.tracking_mode OR NEW.expiry_tracked <> OLD.expiry_tracked)
     AND EXISTS (SELECT 1 FROM inventory_movements m
                  WHERE m.organization_id = OLD.organization_id AND m.item_id = OLD.item_id) THEN
    RAISE EXCEPTION 'item % has stock history; its lot tracking cannot change', OLD.item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE inventory_lots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  item_id             uuid NOT NULL,
  code                text NOT NULL CHECK (code = btrim(code) AND length(code) BETWEEN 1 AND 60),
  expiry_date         date,
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT inventory_lots_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_lots_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id)
);
CREATE UNIQUE INDEX inventory_lots_code_idx ON inventory_lots (organization_id, item_id, lower(code));
CREATE INDEX inventory_lots_expiry_idx ON inventory_lots (organization_id, expiry_date) WHERE expiry_date IS NOT NULL;
CREATE TRIGGER inventory_lots_immutable BEFORE UPDATE OR DELETE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

ALTER TABLE inventory_stock_entries ADD COLUMN lot_id uuid;
ALTER TABLE inventory_stock_entries ADD CONSTRAINT inventory_stock_entries_lot_fkey
  FOREIGN KEY (lot_id, organization_id) REFERENCES inventory_lots (id, organization_id);
CREATE INDEX inventory_stock_entries_lot_idx ON inventory_stock_entries (organization_id, lot_id) WHERE lot_id IS NOT NULL;

CREATE TABLE inventory_lot_levels (
  organization_id  uuid NOT NULL,
  item_id          uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  lot_id           uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (organization_id, lot_id, warehouse_id),
  CONSTRAINT inventory_lot_levels_lot_fkey FOREIGN KEY (lot_id, organization_id)
    REFERENCES inventory_lots (id, organization_id),
  CONSTRAINT inventory_lot_levels_warehouse_fkey FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id)
);
CREATE INDEX inventory_lot_levels_item_idx ON inventory_lot_levels (organization_id, item_id, warehouse_id);

-- An entry names a lot exactly when its item is lot- or serial-tracked, and the lot belongs to the item.
CREATE FUNCTION inventory_check_entry_lot() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  lot_item uuid;
BEGIN
  SELECT tracking_mode INTO mode FROM inventory_items
   WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
  IF mode = 'none' AND NEW.lot_id IS NOT NULL THEN
    RAISE EXCEPTION 'item % is not lot-tracked', NEW.item_id USING ERRCODE = 'check_violation';
  END IF;
  IF mode <> 'none' AND NEW.lot_id IS NULL AND NEW.entry_kind <> 'backfill' THEN
    RAISE EXCEPTION 'item % is lot-tracked: the entry must name a lot', NEW.item_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT item_id INTO lot_item FROM inventory_lots WHERE id = NEW.lot_id AND organization_id = NEW.organization_id;
    IF lot_item IS DISTINCT FROM NEW.item_id THEN
      RAISE EXCEPTION 'the lot does not belong to item %', NEW.item_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_entries_lot_check BEFORE INSERT ON inventory_stock_entries
  FOR EACH ROW EXECUTE FUNCTION inventory_check_entry_lot();

-- Lot levels follow the entries; a serial is held at most once in total.
CREATE FUNCTION inventory_apply_lot_entry() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  total numeric(28, 6);
BEGIN
  IF NEW.lot_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO inventory_lot_levels AS l (organization_id, item_id, warehouse_id, lot_id, quantity)
  VALUES (NEW.organization_id, NEW.item_id, NEW.warehouse_id, NEW.lot_id, NEW.quantity)
  ON CONFLICT (organization_id, lot_id, warehouse_id)
  DO UPDATE SET quantity = l.quantity + EXCLUDED.quantity;
  SELECT tracking_mode INTO mode FROM inventory_items
   WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
  IF mode = 'serial' THEN
    SELECT sum(quantity) INTO total FROM inventory_lot_levels
     WHERE organization_id = NEW.organization_id AND lot_id = NEW.lot_id;
    IF total > 1 THEN
      RAISE EXCEPTION 'serial number is already in stock' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_entries_lot_apply AFTER INSERT ON inventory_stock_entries
  FOR EACH ROW EXECUTE FUNCTION inventory_apply_lot_entry();

-- At commit, for a lot-tracked item the lots held in each warehouse add up to that warehouse's level.
CREATE FUNCTION inventory_check_lot_levels() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  bad record;
BEGIN
  SELECT tracking_mode INTO mode FROM inventory_items
   WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id;
  IF mode IS NULL OR mode = 'none' THEN RETURN NULL; END IF;
  SELECT w.warehouse_id, w.quantity AS warehouse_quantity, coalesce(l.total, 0) AS lot_quantity INTO bad
    FROM inventory_stock_levels w
    LEFT JOIN (SELECT warehouse_id, sum(quantity) AS total FROM inventory_lot_levels
                WHERE organization_id = NEW.organization_id AND item_id = NEW.item_id
                GROUP BY warehouse_id) l ON l.warehouse_id = w.warehouse_id
   WHERE w.organization_id = NEW.organization_id AND w.item_id = NEW.item_id
     AND w.quantity IS DISTINCT FROM coalesce(l.total, 0)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'the lots of item % in warehouse % (%) do not add up to its stock (%)',
      NEW.item_id, bad.warehouse_id, bad.lot_quantity, bad.warehouse_quantity USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER inventory_levels_lots_check AFTER INSERT OR UPDATE ON inventory_stock_levels
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_check_lot_levels();
CREATE CONSTRAINT TRIGGER inventory_lot_levels_check AFTER INSERT OR UPDATE ON inventory_lot_levels
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_check_lot_levels();

-- The lots a draft bill or vendor credit brings in or takes out (set while it is a draft).
CREATE TABLE inventory_document_lots (
  organization_id  uuid NOT NULL,
  document_type    text NOT NULL CHECK (document_type IN ('bill', 'vendor_credit')),
  document_id      uuid NOT NULL,
  item_id          uuid NOT NULL,
  lot_code         text NOT NULL CHECK (lot_code = btrim(lot_code) AND length(lot_code) BETWEEN 1 AND 60),
  expiry_date      date,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (document_type, document_id, item_id, lot_code),
  CONSTRAINT inventory_document_lots_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id)
);
CREATE INDEX inventory_document_lots_doc_idx ON inventory_document_lots (organization_id, document_type, document_id);

-- Lots of adjustments, returns and counts are recorded with their lines for the audit trail.
ALTER TABLE inventory_adjustment_lines ADD COLUMN lots jsonb;
ALTER TABLE inventory_return_lines ADD COLUMN lots jsonb;
ALTER TABLE inventory_transfer_lines ADD COLUMN lots jsonb;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_lots', 'inventory_lot_levels', 'inventory_document_lots'] LOOP
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

GRANT SELECT, INSERT ON inventory_lots TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON inventory_lot_levels TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_document_lots TO intuit_app;
