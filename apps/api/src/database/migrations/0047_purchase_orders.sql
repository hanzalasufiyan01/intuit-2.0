-- 0047_purchase_orders — Purchase orders, goods receiving and three-way matching (approved
-- 2026-10-07).
--
-- * A purchase order (PO-) commits to a vendor for quantities and prices. It creates NO journal:
--   it is not an accounting document. Lifecycle DRAFT → PENDING_APPROVAL → APPROVED →
--   PARTIALLY_RECEIVED → RECEIVED → CLOSED, or CANCELLED. Lines use the bill line columns (tax,
--   dimensions, discounts) plus the quantity received and billed so far.
-- * A goods receipt (GR-) records quantities received against order lines. No goods-received-
--   not-invoiced account in v1: receiving never posts.
-- * A bill is linked to at most one order (`purchase_order_bills`). When the bill posts, its
--   billed quantities are applied to the order lines (`purchase_order_billings`, reversed by the
--   bill void) and the three-way match runs: bill price against order price, billed quantity
--   against received quantity, each with a tolerance. The mode is OFF, WARNING or BLOCK per
--   organization; the result of a posted bill is kept in `purchase_bill_matches`.
-- * Orders accept attachments (file link type 'purchase_order').

CREATE TABLE purchase_order_settings (
  organization_id          uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  match_mode               text NOT NULL DEFAULT 'off' CHECK (match_mode IN ('off', 'warning', 'block')),
  -- Percentages: how far a billed quantity may exceed what was received, and a billed price
  -- may differ from the order price, before the match fails.
  quantity_tolerance_pct   numeric(7, 4) NOT NULL DEFAULT 0 CHECK (quantity_tolerance_pct BETWEEN 0 AND 100),
  price_tolerance_pct      numeric(7, 4) NOT NULL DEFAULT 0 CHECK (price_tolerance_pct BETWEEN 0 AND 100),
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id       uuid REFERENCES users (id),
  updated_at               timestamptz NOT NULL
);

CREATE TABLE purchase_order_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('order', 'receipt')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE purchase_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES accounting_settings (organization_id),
  status                      text NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED',
                                                  'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  number                      text CHECK (number IS NULL OR length(number) BETWEEN 1 AND 40),
  vendor_id                   uuid NOT NULL,
  order_date                  date NOT NULL,
  expected_date               date,
  currency_code               char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  tax_treatment               text NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive', 'no_tax')),
  discount_type               text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value              numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  memo                        text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  dimension_value_ids         uuid[] NOT NULL DEFAULT '{}',
  subtotal                    numeric(28, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total              numeric(28, 4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total                   numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  recoverable_tax_total       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax_total >= 0),
  total                       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  approval_request_id         uuid,
  submitted_by_user_id        uuid REFERENCES users (id),
  submitted_at                timestamptz,
  approved_at                 timestamptz,
  closed_by_user_id           uuid REFERENCES users (id),
  closed_at                   timestamptz,
  close_reason                text CHECK (close_reason IS NULL OR length(btrim(close_reason)) BETWEEN 1 AND 500),
  cancelled_by_user_id        uuid REFERENCES users (id),
  cancelled_at                timestamptz,
  cancel_reason               text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id          uuid NOT NULL REFERENCES users (id),
  created_at                  timestamptz NOT NULL,
  updated_by_user_id          uuid REFERENCES users (id),
  updated_at                  timestamptz NOT NULL,
  CONSTRAINT purchase_orders_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchase_orders_vendor_fkey FOREIGN KEY (vendor_id, organization_id)
    REFERENCES vendors (id, organization_id),
  CONSTRAINT purchase_orders_approval_fkey FOREIGN KEY (approval_request_id, organization_id)
    REFERENCES approval_requests (id, organization_id),
  CONSTRAINT purchase_orders_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchase_orders_recoverable_within_tax CHECK (recoverable_tax_total <= tax_total),
  CONSTRAINT purchase_orders_pending_request CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT purchase_orders_numbered CHECK (status = 'DRAFT' OR number IS NOT NULL),
  CONSTRAINT purchase_orders_expected_after_order CHECK (expected_date IS NULL OR expected_date >= order_date),
  CONSTRAINT purchase_orders_closed_consistency CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT purchase_orders_cancelled_consistency CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status <> 'CANCELLED' OR cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_orders_number_idx ON purchase_orders (organization_id, number) WHERE number IS NOT NULL;
CREATE INDEX purchase_orders_list_idx ON purchase_orders (organization_id, status, order_date DESC, id);
CREATE INDEX purchase_orders_vendor_idx ON purchase_orders (organization_id, vendor_id);

CREATE TABLE purchase_order_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  order_id                  uuid NOT NULL,
  line_no                   integer NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  item_id                   uuid,
  description               text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  account_id                uuid,
  quantity                  numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price                numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  discount_type             text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
  discount_value            numeric(28, 4) CHECK (discount_value IS NULL OR discount_value >= 0),
  amount                    numeric(28, 4) NOT NULL CHECK (amount >= 0),
  line_discount             numeric(28, 4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  document_discount         numeric(28, 4) NOT NULL DEFAULT 0 CHECK (document_discount >= 0),
  net_amount                numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  tax_code_id               uuid,
  tax_rate_id               uuid,
  tax_rate                  numeric(7, 4) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount                numeric(28, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  tax_recoverable_override  boolean,
  tax_recoverable           boolean NOT NULL DEFAULT false,
  recoverable_tax           numeric(28, 4) NOT NULL DEFAULT 0 CHECK (recoverable_tax >= 0),
  non_recoverable_tax       numeric(28, 4) NOT NULL DEFAULT 0 CHECK (non_recoverable_tax >= 0),
  input_tax_account_id      uuid,
  total                     numeric(28, 4) NOT NULL CHECK (total >= 0),
  dimension_value_ids       uuid[] NOT NULL DEFAULT '{}',
  received_quantity         numeric(28, 6) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  billed_quantity           numeric(28, 6) NOT NULL DEFAULT 0 CHECK (billed_quantity >= 0),
  CONSTRAINT purchase_order_lines_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchase_order_lines_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES purchase_orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT purchase_order_lines_number_key UNIQUE (order_id, line_no),
  CONSTRAINT purchase_order_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id),
  CONSTRAINT purchase_order_lines_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchase_order_lines_tax_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT purchase_order_lines_tax_rate_fkey FOREIGN KEY (tax_rate_id, organization_id)
    REFERENCES tax_code_rates (id, organization_id) ON DELETE SET NULL (tax_rate_id),
  CONSTRAINT purchase_order_lines_input_account_fkey FOREIGN KEY (input_tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT purchase_order_lines_discount_consistency CHECK (
    (discount_type IS NULL) = (discount_value IS NULL)
    AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100)),
  CONSTRAINT purchase_order_lines_recoverable_within_tax CHECK (recoverable_tax <= tax_amount)
);

CREATE TABLE purchase_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  order_id             uuid NOT NULL,
  receipt_date         date NOT NULL,
  reference            text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  memo                 text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  status               text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  voided_by_user_id    uuid REFERENCES users (id),
  voided_at            timestamptz,
  void_reason          text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id   uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_by_user_id   uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  CONSTRAINT purchase_receipts_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT purchase_receipts_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES purchase_orders (id, organization_id),
  CONSTRAINT purchase_receipts_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (status <> 'VOID' OR void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_receipts_number_idx ON purchase_receipts (organization_id, number);
CREATE INDEX purchase_receipts_order_idx ON purchase_receipts (organization_id, order_id, receipt_date);

CREATE TABLE purchase_receipt_lines (
  organization_id  uuid NOT NULL,
  receipt_id       uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  order_line_id    uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (receipt_id, line_no),
  CONSTRAINT purchase_receipt_lines_receipt_fkey FOREIGN KEY (receipt_id, organization_id)
    REFERENCES purchase_receipts (id, organization_id),
  CONSTRAINT purchase_receipt_lines_order_line_fkey FOREIGN KEY (order_line_id, organization_id)
    REFERENCES purchase_order_lines (id, organization_id)
);

-- A bill belongs to at most one order.
CREATE TABLE purchase_order_bills (
  organization_id  uuid NOT NULL,
  bill_id          uuid NOT NULL,
  order_id         uuid NOT NULL,
  linked_by_user_id uuid NOT NULL REFERENCES users (id),
  linked_at        timestamptz NOT NULL,
  PRIMARY KEY (organization_id, bill_id),
  -- A draft bill can be deleted with its link; a posted bill is never deleted.
  CONSTRAINT purchase_order_bills_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT purchase_order_bills_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES purchase_orders (id, organization_id)
);
CREATE INDEX purchase_order_bills_order_idx ON purchase_order_bills (organization_id, order_id);

-- What a posted bill applied to the order lines (reversed once, by the bill's void).
CREATE TABLE purchase_order_billings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  bill_id          uuid NOT NULL,
  order_line_id    uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  reversed_at      timestamptz,
  CONSTRAINT purchase_order_billings_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT purchase_order_billings_line_fkey FOREIGN KEY (order_line_id, organization_id)
    REFERENCES purchase_order_lines (id, organization_id)
);
CREATE INDEX purchase_order_billings_bill_idx ON purchase_order_billings (organization_id, bill_id);

-- The three-way match of a posted bill: kept as it was at posting.
CREATE TABLE purchase_bill_matches (
  organization_id  uuid NOT NULL,
  bill_id          uuid NOT NULL,
  order_id         uuid NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('off', 'warning', 'block')),
  status           text NOT NULL CHECK (status IN ('matched', 'warning')),
  issues           jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (organization_id, bill_id),
  CONSTRAINT purchase_bill_matches_bill_fkey FOREIGN KEY (bill_id, organization_id)
    REFERENCES purchases_bills (id, organization_id),
  CONSTRAINT purchase_bill_matches_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES purchase_orders (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION purchase_orders_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft purchase orders can be deleted (order %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'purchase order % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'purchase order % number cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('DRAFT', 'APPROVED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'))
    OR (OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status IN ('APPROVED', 'RECEIVED', 'CLOSED'))
    OR (OLD.status = 'RECEIVED' AND NEW.status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'purchase order % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION '% purchase order % is immutable', lower(OLD.status), OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    -- Once submitted, the commercial terms are fixed; only the lifecycle columns change.
    IF (NEW.vendor_id, NEW.order_date, NEW.expected_date, NEW.currency_code, NEW.tax_treatment,
        NEW.discount_type, NEW.discount_value, NEW.memo, NEW.dimension_value_ids, NEW.subtotal,
        NEW.discount_total, NEW.tax_total, NEW.recoverable_tax_total, NEW.total)
       IS DISTINCT FROM
       (OLD.vendor_id, OLD.order_date, OLD.expected_date, OLD.currency_code, OLD.tax_treatment,
        OLD.discount_type, OLD.discount_value, OLD.memo, OLD.dimension_value_ids, OLD.subtotal,
        OLD.discount_total, OLD.tax_total, OLD.recoverable_tax_total, OLD.total) THEN
      RAISE EXCEPTION 'submitted purchase order % cannot be edited', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_orders_guard
  BEFORE UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();

-- Lines change while their order is a draft; after that only the quantities received and billed.
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_row    record;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.order_id)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.order_id) THEN
    RAISE EXCEPTION 'purchase order line % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO v_status FROM purchase_orders
   WHERE id = v_row.order_id AND organization_id = v_row.organization_id;
  IF v_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF v_status = 'DRAFT' THEN
    RETURN v_row;
  END IF;
  IF TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - 'received_quantity' - 'billed_quantity'
         IS NOT DISTINCT FROM to_jsonb(OLD) - 'received_quantity' - 'billed_quantity' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lines of a submitted purchase order are immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- A receipt changes only by its void; its lines never change.
CREATE FUNCTION purchase_receipts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goods receipts are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void goods receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'VOID' AND to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by_user_id'
       IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by_user_id' THEN
    RAISE EXCEPTION 'posted goods receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_receipts_guard
  BEFORE UPDATE OR DELETE ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION purchase_receipts_guard();
CREATE TRIGGER purchase_receipt_lines_immutable
  BEFORE UPDATE OR DELETE ON purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- A link ends only with its draft bill; a match is history; a billing is reversed once.
CREATE TRIGGER purchase_order_bills_immutable
  BEFORE UPDATE ON purchase_order_bills
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER purchase_bill_matches_immutable
  BEFORE UPDATE OR DELETE ON purchase_bill_matches
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE FUNCTION purchase_order_billings_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase order billings are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.bill_id, NEW.order_line_id, NEW.quantity)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.bill_id, OLD.order_line_id, OLD.quantity)
     OR OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'purchase order billing % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_billings_guard
  BEFORE UPDATE OR DELETE ON purchase_order_billings
  FOR EACH ROW EXECUTE FUNCTION purchase_order_billings_guard();

-- ---------------------------------------------------------------------------
-- Attachments, truncation, RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill',
                'vendor_credit', 'vendor_payment', 'expense', 'purchase_order'));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase_order_settings', 'purchase_order_number_sequences', 'purchase_orders',
    'purchase_order_lines', 'purchase_receipts', 'purchase_receipt_lines', 'purchase_order_bills',
    'purchase_order_billings', 'purchase_bill_matches'
  ] LOOP
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
-- Drafts and their lines are deleted.
GRANT DELETE ON purchase_orders, purchase_order_lines, purchase_order_bills TO intuit_app;

-- ---------------------------------------------------------------------------
-- Permissions and the backfill for existing organizations
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('purchase_orders.view', 'purchases', 'View purchase orders, goods receipts and commitments'),
  ('purchase_orders.create', 'purchases', 'Create, edit, submit and link purchase orders to bills'),
  ('purchase_orders.approve', 'purchases', 'Approve purchase orders'),
  ('purchase_orders.receive', 'purchases', 'Record and void goods receipts'),
  ('purchase_orders.close', 'purchases', 'Close and cancel purchase orders'),
  ('purchase_orders.settings.manage', 'purchases', 'Manage three-way matching settings')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE purchase_order_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO purchase_order_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('purchase_orders.view'), ('purchase_orders.create'), ('purchase_orders.approve'),
  ('purchase_orders.receive'), ('purchase_orders.close'), ('purchase_orders.settings.manage')
) AS p (key);
INSERT INTO purchase_order_backfill_grants (template_key, permission_key) VALUES
  ('member', 'purchase_orders.view');

CREATE TEMPORARY TABLE purchase_order_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN purchase_order_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO purchase_order_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0047_purchase_orders',
       jsonb_build_object(
         'reason', 'Purchase order permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM purchase_order_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
