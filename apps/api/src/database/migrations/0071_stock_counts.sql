-- 0071_stock_counts — physical stock counts that post their differences as a stock adjustment
-- (FP-29 A5, docs/design/advanced-inventory.md).
--
-- A count lists the tracked items with the quantity the system expected when the count started;
-- people enter what they counted; posting turns every difference into ONE stock adjustment (the
-- existing adjustment flow: journal, stock movements, audit) measured against the quantity on hand
-- AT POSTING, so the books end up equal to what was physically counted. A posted count is final.
-- The adjustment, not the count, is voided if it must be undone.

INSERT INTO permissions (key, module, description) VALUES
  ('inventory.counts.manage', 'inventory', 'Start, enter, post and cancel physical stock counts')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE counts_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO counts_backfill_grants (template_key, permission_key)
SELECT t.template_key, 'inventory.counts.manage' FROM (VALUES ('owner'), ('administrator')) AS t (template_key);

CREATE TEMPORARY TABLE counts_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN counts_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO counts_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0071_stock_counts',
       jsonb_build_object(
         'reason', 'Stock count permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM counts_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

ALTER TABLE inventory_number_sequences DROP CONSTRAINT inventory_number_sequences_document_type_check;
ALTER TABLE inventory_number_sequences ADD CONSTRAINT inventory_number_sequences_document_type_check
  CHECK (document_type IN ('adjustment', 'return', 'count'));

CREATE TABLE inventory_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  count_date          date NOT NULL,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  memo                text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  adjustment_id       uuid,
  posted_at           timestamptz,
  posted_by_user_id   uuid REFERENCES users (id),
  cancel_reason       text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT inventory_counts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_counts_adjustment_fkey FOREIGN KEY (adjustment_id, organization_id)
    REFERENCES inventory_adjustments (id, organization_id),
  CONSTRAINT inventory_counts_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL)),
  CONSTRAINT inventory_counts_cancel CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX inventory_counts_number_idx ON inventory_counts (organization_id, number);
CREATE INDEX inventory_counts_list_idx ON inventory_counts (organization_id, count_date DESC, id);

CREATE TABLE inventory_count_lines (
  organization_id    uuid NOT NULL,
  count_id           uuid NOT NULL,
  item_id            uuid NOT NULL,
  -- The system quantity when the count started (informational once stock moves).
  expected_quantity  numeric(28, 6) NOT NULL,
  -- NULL until counted; an uncounted line is left alone when the count is posted.
  counted_quantity   numeric(28, 6) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  PRIMARY KEY (count_id, item_id),
  CONSTRAINT inventory_count_lines_count_fkey FOREIGN KEY (count_id, organization_id)
    REFERENCES inventory_counts (id, organization_id),
  CONSTRAINT inventory_count_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id)
);

CREATE FUNCTION inventory_guard_count() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock counts are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION '% stock count % is final', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status NOT IN ('DRAFT', 'POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid count status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_counts_guard BEFORE UPDATE OR DELETE ON inventory_counts
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_count();

-- Lines change only while the count is a draft; a line's item and expected quantity never change.
CREATE FUNCTION inventory_guard_count_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  count_status text;
BEGIN
  SELECT status INTO count_status FROM inventory_counts
   WHERE id = COALESCE(OLD.count_id, NEW.count_id)
     AND organization_id = COALESCE(OLD.organization_id, NEW.organization_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'count lines are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF count_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'the lines of a count that is not a draft cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.item_id, NEW.expected_quantity) IS DISTINCT FROM (OLD.item_id, OLD.expected_quantity) THEN
      RAISE EXCEPTION 'the item and expected quantity of a count line are fixed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_count_lines_guard BEFORE UPDATE OR DELETE ON inventory_count_lines
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_count_line();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_counts', 'inventory_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO intuit_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
