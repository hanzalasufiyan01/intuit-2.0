-- 0080_lot_levels_fix — a lot level must be updated before it is inserted.
--
-- 0079 maintained inventory_lot_levels with INSERT ... ON CONFLICT DO UPDATE. PostgreSQL checks the
-- inserted row against CHECK (quantity >= 0) BEFORE it resolves the conflict, so an entry that takes
-- stock out of a lot (a negative quantity) was refused even when the lot had the stock. Update the
-- existing row first and insert only when there is none; the non-negative check then applies to the
-- resulting level, which is what it is for.

CREATE OR REPLACE FUNCTION inventory_apply_lot_entry() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  total numeric(28, 6);
BEGIN
  IF NEW.lot_id IS NULL THEN RETURN NEW; END IF;
  UPDATE inventory_lot_levels
     SET quantity = quantity + NEW.quantity
   WHERE organization_id = NEW.organization_id AND lot_id = NEW.lot_id AND warehouse_id = NEW.warehouse_id;
  IF NOT FOUND THEN
    INSERT INTO inventory_lot_levels (organization_id, item_id, warehouse_id, lot_id, quantity)
    VALUES (NEW.organization_id, NEW.item_id, NEW.warehouse_id, NEW.lot_id, NEW.quantity);
  END IF;
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
