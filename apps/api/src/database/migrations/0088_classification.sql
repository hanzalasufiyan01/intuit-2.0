-- 0088_classification — customer groups, custom fields on customers, product categories and
-- barcodes (master specification sections 10, 16 and 18).
--
-- All of these are SIDE TABLES: the frozen customer and item records are not altered, so nothing
-- that posts, prices or reports from them changes. The specification names the features but not
-- their rules, so the model is deliberately the smallest one: a customer is in at most one group, a
-- group is just a name, an item is in at most one category (flat list), an item may have several
-- barcodes and a barcode belongs to one item. Custom fields are typed (text, number, date, yes/no,
-- list), live on customers only, and never feed accounting.

CREATE TABLE customer_groups (
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
  CONSTRAINT customer_groups_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT customer_groups_name_key UNIQUE (organization_id, name_key)
);

CREATE TABLE customer_group_members (
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  customer_id      uuid NOT NULL,
  group_id         uuid NOT NULL,
  set_by_user_id   uuid NOT NULL REFERENCES users (id),
  set_at           timestamptz NOT NULL,
  PRIMARY KEY (customer_id),
  CONSTRAINT customer_group_members_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT customer_group_members_group_fkey FOREIGN KEY (group_id, organization_id)
    REFERENCES customer_groups (id, organization_id)
);
CREATE INDEX customer_group_members_group_idx ON customer_group_members (organization_id, group_id);

CREATE TABLE custom_field_definitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  entity              text NOT NULL CHECK (entity IN ('customer')),
  key                 text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label               text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  field_type          text NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'list')),
  -- Allowed choices of a list field (2 to 50 non-empty strings); NULL for the other types.
  options             jsonb,
  sort_order          integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT custom_field_definitions_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT custom_field_definitions_key UNIQUE (organization_id, entity, key),
  CONSTRAINT custom_field_definitions_options CHECK (
    (field_type = 'list') = (options IS NOT NULL)
    AND (options IS NULL OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 50)))
);

-- The key and type of a field never change (values stored under them keep their meaning).
CREATE FUNCTION custom_field_definition_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'custom fields are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.entity, NEW.key, NEW.field_type)
     IS DISTINCT FROM (OLD.organization_id, OLD.entity, OLD.key, OLD.field_type) THEN
    RAISE EXCEPTION 'the key and type of custom field % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER custom_field_definitions_guard BEFORE UPDATE OR DELETE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION custom_field_definition_guard();

CREATE TABLE custom_field_values (
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  field_id            uuid NOT NULL,
  record_id           uuid NOT NULL,
  value               jsonb NOT NULL,
  updated_by_user_id  uuid NOT NULL REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  PRIMARY KEY (field_id, record_id),
  CONSTRAINT custom_field_values_field_fkey FOREIGN KEY (field_id, organization_id)
    REFERENCES custom_field_definitions (id, organization_id)
);
CREATE INDEX custom_field_values_record_idx ON custom_field_values (organization_id, record_id);

CREATE TABLE item_categories (
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
  CONSTRAINT item_categories_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT item_categories_name_key UNIQUE (organization_id, name_key)
);

CREATE TABLE item_category_assignments (
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  item_id          uuid NOT NULL,
  category_id      uuid NOT NULL,
  set_by_user_id   uuid NOT NULL REFERENCES users (id),
  set_at           timestamptz NOT NULL,
  PRIMARY KEY (item_id),
  CONSTRAINT item_category_assignments_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT item_category_assignments_category_fkey FOREIGN KEY (category_id, organization_id)
    REFERENCES item_categories (id, organization_id)
);
CREATE INDEX item_category_assignments_category_idx
  ON item_category_assignments (organization_id, category_id);

CREATE TABLE item_barcodes (
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  barcode             text NOT NULL CHECK (barcode ~ '^[\x21-\x7e]{1,64}$'),
  item_id             uuid NOT NULL,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, barcode),
  CONSTRAINT item_barcodes_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id)
);
CREATE INDEX item_barcodes_item_idx ON item_barcodes (organization_id, item_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customer_groups', 'customer_group_members', 'custom_field_definitions',
    'custom_field_values', 'item_categories', 'item_category_assignments', 'item_barcodes'
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
GRANT SELECT, INSERT, UPDATE ON customer_groups, custom_field_definitions, item_categories TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_group_members, custom_field_values,
  item_category_assignments, item_barcodes TO intuit_app;
