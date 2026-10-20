-- 0081_landed_cost — landed cost allocated to the stock of a posted bill (FP-29 A8, ADR 0014 AI-08).
--
-- A landed-cost document (LC-) takes freight, duty or handling that arrived after the bill and
-- spreads it over the bill's tracked items. The share belonging to units still on hand raises the
-- stock value (a VALUE-ONLY stock movement: quantity zero); the share belonging to units already
-- sold goes to cost of goods sold. One journal posts both against the account the user chose.
-- Voiding reverses the journal and the movements.

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check CHECK (kind IN
  ('purchase', 'purchase_void', 'sale', 'sale_void', 'adjustment', 'adjustment_void',
   'sales_return', 'sales_return_void', 'purchase_return', 'purchase_return_void',
   'landed_cost', 'landed_cost_void'));
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_void_link;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_void_link CHECK (
  (kind IN ('purchase_void', 'sale_void', 'adjustment_void', 'sales_return_void',
            'purchase_return_void', 'landed_cost_void')) = (reverses_id IS NOT NULL));
-- Only a landed cost moves value without moving any quantity.
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_quantity_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_quantity_check CHECK (
  quantity <> 0 OR kind IN ('landed_cost', 'landed_cost_void'));

ALTER TABLE inventory_number_sequences DROP CONSTRAINT inventory_number_sequences_document_type_check;
ALTER TABLE inventory_number_sequences ADD CONSTRAINT inventory_number_sequences_document_type_check
  CHECK (document_type IN ('adjustment', 'return', 'count', 'transfer', 'landed_cost'));

CREATE TABLE inventory_landed_costs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  cost_date            date NOT NULL,
  bill_id              uuid NOT NULL,
  description          text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  -- In the base currency of the organization.
  amount               numeric(28, 4) NOT NULL CHECK (amount > 0),
  basis                text NOT NULL CHECK (basis IN ('value', 'quantity')),
  credit_account_id    uuid NOT NULL,
  status               text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
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
  CONSTRAINT inventory_landed_costs_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT inventory_landed_costs_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT inventory_landed_costs_account_fkey FOREIGN KEY (credit_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT inventory_landed_costs_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_landed_costs_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT inventory_landed_costs_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR (void_reason IS NOT NULL AND void_journal_id IS NOT NULL)))
);
CREATE UNIQUE INDEX inventory_landed_costs_number_idx ON inventory_landed_costs (organization_id, number);
CREATE INDEX inventory_landed_costs_bill_idx ON inventory_landed_costs (organization_id, bill_id);
CREATE INDEX inventory_landed_costs_list_idx ON inventory_landed_costs (organization_id, cost_date DESC, id);

CREATE TABLE inventory_landed_cost_lines (
  organization_id    uuid NOT NULL,
  landed_cost_id     uuid NOT NULL,
  line_no            integer NOT NULL CHECK (line_no >= 1),
  item_id            uuid NOT NULL,
  allocated          numeric(28, 4) NOT NULL CHECK (allocated >= 0),
  to_inventory       numeric(28, 4) NOT NULL CHECK (to_inventory >= 0),
  to_cogs            numeric(28, 4) NOT NULL CHECK (to_cogs >= 0),
  movement_id        uuid,
  PRIMARY KEY (landed_cost_id, line_no),
  CONSTRAINT inventory_landed_cost_lines_split CHECK (to_inventory + to_cogs = allocated),
  CONSTRAINT inventory_landed_cost_lines_cost_fkey FOREIGN KEY (landed_cost_id, organization_id)
    REFERENCES inventory_landed_costs (id, organization_id),
  CONSTRAINT inventory_landed_cost_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES inventory_items (item_id, organization_id),
  CONSTRAINT inventory_landed_cost_lines_movement_fkey FOREIGN KEY (movement_id, organization_id)
    REFERENCES inventory_movements (id, organization_id)
);
CREATE UNIQUE INDEX inventory_landed_cost_lines_item_idx ON inventory_landed_cost_lines (landed_cost_id, item_id);

-- Landed costs never change after posting except for their void.
CREATE FUNCTION inventory_guard_landed_cost() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'landed costs are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void landed cost % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.number, NEW.cost_date, NEW.bill_id, NEW.amount, NEW.basis, NEW.credit_account_id, NEW.journal_id)
     IS DISTINCT FROM (OLD.number, OLD.cost_date, OLD.bill_id, OLD.amount, OLD.basis, OLD.credit_account_id, OLD.journal_id) THEN
    RAISE EXCEPTION 'the content of landed cost % is fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_landed_costs_guard BEFORE UPDATE OR DELETE ON inventory_landed_costs
  FOR EACH ROW EXECUTE FUNCTION inventory_guard_landed_cost();
CREATE TRIGGER inventory_landed_cost_lines_immutable BEFORE UPDATE OR DELETE ON inventory_landed_cost_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_landed_costs', 'inventory_landed_cost_lines'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON inventory_landed_costs TO intuit_app;
GRANT SELECT, INSERT ON inventory_landed_cost_lines TO intuit_app;
