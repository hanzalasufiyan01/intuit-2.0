-- 0090_variants_bins — product variants and internal locations (master specification section 18).
--
-- REVERSIBLE DEFAULTS chosen by the implementer (docs/decisions/0015-completion-defaults.md); the
-- specification names the features without defining them:
--  * A VARIANT is an ordinary item (own SKU, price, stock, cost, barcodes) that belongs to a variant
--    GROUP (the "parent", for example "T-shirt") and carries ATTRIBUTES (size, colour...). Nothing
--    about the item, its stock or its posting changes; the group only organises and lets reports
--    and screens show the variants together. No two variants of a group share the same attributes.
--  * A BIN is a named internal location inside a warehouse (shelf, aisle, cold room). An item may
--    have a DEFAULT BIN per warehouse. Bins are LABELS: stock is still tracked per warehouse (ADR
--    0014), not per bin. Per-bin stock would change the placement ledger and needs a new ADR.

CREATE TABLE variant_groups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  name_key            text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT variant_groups_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT variant_groups_name_key UNIQUE (organization_id, name_key)
);

CREATE TABLE variant_group_members (
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  item_id          uuid NOT NULL,
  group_id         uuid NOT NULL,
  -- {"size": "L", "colour": "Blue"}: 1 to 6 attributes, text values.
  attributes       jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object' AND attributes <> '{}'::jsonb),
  set_by_user_id   uuid NOT NULL REFERENCES users (id),
  set_at           timestamptz NOT NULL,
  PRIMARY KEY (item_id),
  CONSTRAINT variant_group_members_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT variant_group_members_group_fkey FOREIGN KEY (group_id, organization_id)
    REFERENCES variant_groups (id, organization_id)
);
CREATE UNIQUE INDEX variant_group_members_attributes_idx
  ON variant_group_members (organization_id, group_id, attributes);

CREATE TABLE warehouse_bins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  warehouse_id        uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name                text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT warehouse_bins_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT warehouse_bins_warehouse_fkey FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES inventory_warehouses (id, organization_id)
);
CREATE UNIQUE INDEX warehouse_bins_code_idx ON warehouse_bins (organization_id, warehouse_id, lower(code));

CREATE TABLE item_default_bins (
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  item_id          uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  bin_id           uuid NOT NULL,
  set_by_user_id   uuid NOT NULL REFERENCES users (id),
  set_at           timestamptz NOT NULL,
  PRIMARY KEY (item_id, warehouse_id),
  CONSTRAINT item_default_bins_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT item_default_bins_bin_fkey FOREIGN KEY (bin_id, organization_id)
    REFERENCES warehouse_bins (id, organization_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['variant_groups', 'variant_group_members', 'warehouse_bins', 'item_default_bins'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON variant_groups, warehouse_bins TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON variant_group_members, item_default_bins TO intuit_app;
