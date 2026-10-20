-- 0077_inventory_bundles — sales bundles (kits) that expand into tracked component items at issue
-- (FP-29 A7, docs/design/advanced-inventory.md).
--
-- A bundle is a catalog item that is NOT stock-tracked itself and has one or more component rows.
-- When an invoice with a bundle line is issued, the stock of each component leaves at its own
-- average cost (cost of goods sold per component); revenue is the bundle line as invoiced. Bundles
-- cannot nest, a bundle cannot be tracked, and a tracked item that is a component cannot stop
-- being tracked while the bundle uses it. Editing a bundle affects future invoices only.

CREATE TABLE inventory_bundle_components (
  organization_id    uuid NOT NULL,
  bundle_item_id     uuid NOT NULL,
  component_item_id  uuid NOT NULL,
  quantity           numeric(28, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (bundle_item_id, component_item_id),
  CONSTRAINT inventory_bundle_components_distinct CHECK (bundle_item_id <> component_item_id),
  CONSTRAINT inventory_bundle_components_bundle_fkey FOREIGN KEY (bundle_item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT inventory_bundle_components_component_fkey FOREIGN KEY (component_item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id)
);
CREATE INDEX inventory_bundle_components_org_idx
  ON inventory_bundle_components (organization_id, bundle_item_id);
CREATE INDEX inventory_bundle_components_component_idx
  ON inventory_bundle_components (organization_id, component_item_id);

CREATE FUNCTION inventory_guard_bundle_component() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_items i
              WHERE i.organization_id = NEW.organization_id AND i.item_id = NEW.bundle_item_id) THEN
    RAISE EXCEPTION 'item % is stock-tracked and cannot be a bundle', NEW.bundle_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_bundle_components c
              WHERE c.organization_id = NEW.organization_id AND c.bundle_item_id = NEW.component_item_id) THEN
    RAISE EXCEPTION 'item % is a bundle; bundles cannot nest', NEW.component_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_bundle_components c
              WHERE c.organization_id = NEW.organization_id AND c.component_item_id = NEW.bundle_item_id) THEN
    RAISE EXCEPTION 'item % is a component of another bundle; bundles cannot nest', NEW.bundle_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_bundle_components_guard
  BEFORE INSERT OR UPDATE ON inventory_bundle_components
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_bundle_component();

-- An item that is a bundle cannot start being tracked.
CREATE FUNCTION inventory_guard_tracking_bundle() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_bundle_components c
              WHERE c.organization_id = NEW.organization_id AND c.bundle_item_id = NEW.item_id) THEN
    RAISE EXCEPTION 'item % is a bundle and cannot be stock-tracked', NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_items_not_bundle
  BEFORE INSERT ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_tracking_bundle();

ALTER TABLE inventory_bundle_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_bundle_components_tenant ON inventory_bundle_components FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON inventory_bundle_components FROM PUBLIC;
CREATE TRIGGER inventory_bundle_components_no_truncate BEFORE TRUNCATE ON inventory_bundle_components
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_bundle_components TO intuit_app;
