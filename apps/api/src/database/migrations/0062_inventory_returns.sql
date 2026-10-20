-- 0062_inventory_returns — customer returns put goods back into stock (master context section 18
-- "Returns", ADR 0006 known deviation, ADR 0012).
--
-- A credit note reverses revenue and the receivable but, until now, neither restored stock nor
-- reversed the cost of goods sold. A stock return is a source document (`RET-`) that references an
-- ISSUED credit note and records which tracked items came back and how many. Posting it
--   * puts the quantity back into stock at the cost the goods left it (the linked invoice's sale
--     movement; the current average when the credit note has no invoice),
--   * posts Dr inventory / Cr cost of goods sold through the `inventory.sales_return_posted`
--     accounting event, with the credit note's dimensions (additive: the credit note's own journal
--     is untouched),
--   * can be voided (the journal is reversed and the stock leaves again at the same value).
-- The quantity returned per item can never exceed what the credit note credited, summed over all
-- non-void returns of that credit note. Permissions reuse `inventory.adjustments.create` and
-- `inventory.adjustments.void` (a return is a kind of stock adjustment): no permission key is added.

ALTER TABLE inventory_number_sequences DROP CONSTRAINT inventory_number_sequences_document_type_check;
ALTER TABLE inventory_number_sequences ADD CONSTRAINT inventory_number_sequences_document_type_check
  CHECK (document_type IN ('adjustment', 'return'));

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check CHECK (kind IN
  ('purchase', 'purchase_void', 'sale', 'sale_void', 'adjustment', 'adjustment_void',
   'sales_return', 'sales_return_void'));
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_void_link;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_void_link CHECK (
  (kind IN ('purchase_void', 'sale_void', 'adjustment_void', 'sales_return_void')) = (reverses_id IS NOT NULL));

CREATE TABLE inventory_returns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  return_date          date NOT NULL,
  credit_note_id       uuid NOT NULL,
  reason               text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  memo                 text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  status               text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  total_value          numeric(28, 4) NOT NULL CHECK (total_value >= 0),
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
  CONSTRAINT inventory_returns_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_returns_credit_note_fkey FOREIGN KEY (credit_note_id, organization_id)
    REFERENCES sales_credit_notes (id, organization_id),
  CONSTRAINT inventory_returns_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_returns_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT inventory_returns_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_returns_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX inventory_returns_number_idx ON inventory_returns (organization_id, number);
CREATE INDEX inventory_returns_list_idx ON inventory_returns (organization_id, return_date DESC, id);
CREATE INDEX inventory_returns_credit_note_idx ON inventory_returns (organization_id, credit_note_id);

CREATE TABLE inventory_return_lines (
  organization_id  uuid NOT NULL,
  return_id        uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_cost        numeric(28, 6) NOT NULL CHECK (unit_cost >= 0),
  value            numeric(28, 4) NOT NULL CHECK (value >= 0),
  movement_id      uuid NOT NULL,
  PRIMARY KEY (return_id, line_no),
  CONSTRAINT inventory_return_lines_return_fkey FOREIGN KEY (return_id, organization_id)
    REFERENCES inventory_returns (id, organization_id),
  CONSTRAINT inventory_return_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_return_lines_movement_fkey FOREIGN KEY (movement_id, organization_id)
    REFERENCES inventory_movements (id, organization_id),
  CONSTRAINT inventory_return_lines_item_once UNIQUE (return_id, item_id)
);

-- Only the void of a posted return changes it; nothing is deleted.
CREATE FUNCTION inventory_guard_return() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'returns are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void return % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'VOID' AND to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by_user_id'
       IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by_user_id' THEN
    RAISE EXCEPTION 'posted return % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_returns_guard
  BEFORE UPDATE OR DELETE ON inventory_returns
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_return();
CREATE TRIGGER inventory_return_lines_immutable
  BEFORE UPDATE OR DELETE ON inventory_return_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_returns', 'inventory_return_lines'] LOOP
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
