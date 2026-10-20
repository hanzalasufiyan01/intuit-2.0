-- 0091_delivery_reservations — delivery notes and stock reservations (master specification
-- sections 12 and 18).
--
-- REVERSIBLE DEFAULTS chosen by the implementer (docs/decisions/0015-completion-defaults.md); the
-- specification names both features without defining them:
--  * DELIVERY NOTE: the "Delivery / Service Completion" stage between a sales order and an invoice.
--    It records WHAT was delivered against a CONFIRMED sales order, in quantities that can never
--    exceed what the order still has open. It is fulfilment only: it moves no stock and posts
--    nothing to the ledger (stock and cost of sales still move when the invoice is issued, ADR
--    0014). A delivered note is final; it can be voided with a reason, which frees its quantities.
--  * RESERVATION: an ADVISORY hold on stock for an item (manual, or from a sales order). It never
--    blocks a sale or a transfer; it lowers "available to promise" (on hand minus reserved). An
--    order reservation shrinks by what the order has invoiced and ends when the order is cancelled.

CREATE TABLE delivery_number_sequences (
  organization_id  uuid PRIMARY KEY REFERENCES organizations (id),
  prefix           text NOT NULL DEFAULT 'DLV-' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);

CREATE TABLE delivery_notes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id),
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  order_id             uuid NOT NULL,
  delivery_date        date NOT NULL,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DELIVERED', 'VOID')),
  memo                 text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  delivered_by_user_id uuid REFERENCES users (id),
  delivered_at         timestamptz,
  void_reason          text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  voided_by_user_id    uuid REFERENCES users (id),
  voided_at            timestamptz,
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  CONSTRAINT delivery_notes_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT delivery_notes_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES sales_orders (id, organization_id),
  CONSTRAINT delivery_notes_void CHECK ((status = 'VOID') = (void_reason IS NOT NULL)),
  CONSTRAINT delivery_notes_delivered CHECK ((status IN ('DELIVERED', 'VOID')) = (delivered_at IS NOT NULL))
);
CREATE UNIQUE INDEX delivery_notes_number_idx ON delivery_notes (organization_id, number);
CREATE INDEX delivery_notes_order_idx ON delivery_notes (organization_id, order_id);

CREATE TABLE delivery_note_lines (
  organization_id  uuid NOT NULL,
  note_id          uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  order_id         uuid NOT NULL,
  order_line_no    integer NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (note_id, line_no),
  CONSTRAINT delivery_note_lines_note_fkey FOREIGN KEY (note_id, organization_id)
    REFERENCES delivery_notes (id, organization_id),
  CONSTRAINT delivery_note_lines_order_line_fkey FOREIGN KEY (order_id, order_line_no)
    REFERENCES sales_order_lines (order_id, line_no),
  CONSTRAINT delivery_note_lines_once UNIQUE (note_id, order_line_no)
);

-- A note can be edited only while it is a draft; a delivered note changes only by being voided.
CREATE FUNCTION delivery_note_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a delivered or void delivery note cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'a void delivery note is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'DELIVERED' AND NEW.status <> 'VOID' THEN
    RAISE EXCEPTION 'a delivered note can only be voided' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.order_id, NEW.delivery_date)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.number, OLD.order_id, OLD.delivery_date)
     AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a delivered note cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_notes_guard BEFORE UPDATE OR DELETE ON delivery_notes
  FOR EACH ROW EXECUTE FUNCTION delivery_note_guard();

CREATE FUNCTION delivery_note_line_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s text;
  n uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.note_id ELSE NEW.note_id END;
  o uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
BEGIN
  SELECT status INTO s FROM delivery_notes WHERE id = n AND organization_id = o;
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'delivery note lines change only while the note is a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER delivery_note_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_note_lines
  FOR EACH ROW EXECUTE FUNCTION delivery_note_line_guard();

CREATE TABLE stock_reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  item_id             uuid NOT NULL,
  quantity            numeric(28, 6) NOT NULL CHECK (quantity > 0),
  source              text NOT NULL CHECK (source IN ('manual', 'sales_order')),
  order_id            uuid,
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  expires_on          date,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  released_at         timestamptz,
  released_by_user_id uuid REFERENCES users (id),
  release_reason      text CHECK (release_reason IS NULL OR length(release_reason) <= 200),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT stock_reservations_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT stock_reservations_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT stock_reservations_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES sales_orders (id, organization_id),
  CONSTRAINT stock_reservations_source CHECK ((source = 'sales_order') = (order_id IS NOT NULL)),
  CONSTRAINT stock_reservations_released CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX stock_reservations_item_idx ON stock_reservations (organization_id, item_id, status);
CREATE INDEX stock_reservations_order_idx ON stock_reservations (organization_id, order_id);

-- A reservation is released, never deleted or re-pointed.
CREATE FUNCTION stock_reservation_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations are released, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.item_id, NEW.quantity, NEW.source, NEW.order_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.item_id, OLD.quantity, OLD.source, OLD.order_id)
     OR (OLD.status = 'RELEASED' AND NEW.status <> 'RELEASED') THEN
    RAISE EXCEPTION 'a reservation can only be released' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_reservations_guard BEFORE UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION stock_reservation_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_number_sequences', 'delivery_notes', 'delivery_note_lines', 'stock_reservations'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON delivery_number_sequences, stock_reservations TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_notes, delivery_note_lines TO intuit_app;
