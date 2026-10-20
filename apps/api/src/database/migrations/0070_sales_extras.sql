-- 0070_sales_extras — payment reminders, sales orders and read-only invoice share links (FP-28).
--
-- * Payment reminders: an optional automatic schedule (off by default) and a manual action send a
--   plain e-mail about an overdue issued invoice. Every reminder is recorded and never edited; an
--   automatic stage is sent at most once per invoice (unique), a manual reminder at most once a day.
-- * Sales orders: a customer's confirmed order, invoiced (fully or in parts) through DRAFT
--   invoices. Invoiced quantity is derived from the invoices that still exist, so deleting a draft
--   releases its quantity; nothing is posted by an order.
-- * Share links: a customer-facing, read-only view of ONE issued invoice behind an unguessable
--   token (only its hash is stored), with an expiry, revocation and a view counter. This is the
--   safe first step of the customer portal; accounts and payments for customers are open decisions.

INSERT INTO permissions (key, module, description) VALUES
  ('payment_reminders.view', 'sales', 'View overdue invoices and payment reminders'),
  ('payment_reminders.send', 'sales', 'Send payment reminders for overdue invoices'),
  ('payment_reminders.settings.manage', 'sales', 'Manage the automatic payment reminder schedule'),
  ('sales_orders.view', 'sales', 'View sales orders'),
  ('sales_orders.create', 'sales', 'Create, edit, confirm and cancel sales orders'),
  ('sales_orders.invoice', 'sales', 'Create draft invoices from confirmed sales orders'),
  ('invoice_links.manage', 'sales', 'Create and revoke read-only share links for issued invoices')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE sales_extras_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO sales_extras_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('payment_reminders.view'), ('payment_reminders.send'), ('payment_reminders.settings.manage'),
  ('sales_orders.view'), ('sales_orders.create'), ('sales_orders.invoice'), ('invoice_links.manage')
) AS p (key);

CREATE TEMPORARY TABLE sales_extras_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN sales_extras_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO sales_extras_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0070_sales_extras',
       jsonb_build_object(
         'reason', 'Reminder, sales order and share link permission backfill',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM sales_extras_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

-- ---------------------------------------------------------------------------
-- Payment reminders
-- ---------------------------------------------------------------------------

CREATE TABLE payment_reminder_settings (
  organization_id     uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  auto_enabled        boolean NOT NULL DEFAULT false,
  first_after_days    integer NOT NULL DEFAULT 3 CHECK (first_after_days BETWEEN 0 AND 365),
  repeat_every_days   integer NOT NULL DEFAULT 7 CHECK (repeat_every_days BETWEEN 1 AND 365),
  max_reminders       integer NOT NULL DEFAULT 3 CHECK (max_reminders BETWEEN 1 AND 20),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL
);

CREATE TABLE payment_reminders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  customer_id       uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('manual', 'auto')),
  -- Automatic reminders are numbered 1, 2, ... per invoice; manual ones carry no stage.
  stage             integer CHECK (stage IS NULL OR stage >= 1),
  recipient         text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  open_amount       numeric(28, 4) NOT NULL CHECK (open_amount > 0),
  currency_code     char(3) NOT NULL,
  days_overdue      integer NOT NULL CHECK (days_overdue >= 0),
  sent_by_user_id   uuid REFERENCES users (id),
  sent_at           timestamptz NOT NULL,
  CONSTRAINT payment_reminders_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id),
  CONSTRAINT payment_reminders_kind_stage CHECK ((kind = 'auto') = (stage IS NOT NULL))
);
CREATE INDEX payment_reminders_invoice_idx ON payment_reminders (organization_id, invoice_id, sent_at DESC);
CREATE UNIQUE INDEX payment_reminders_auto_once_idx ON payment_reminders (invoice_id, stage)
  WHERE kind = 'auto';
CREATE TRIGGER payment_reminders_immutable BEFORE UPDATE OR DELETE ON payment_reminders
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

CREATE FUNCTION app_organizations_with_auto_reminders()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT organization_id FROM payment_reminder_settings WHERE auto_enabled
$$;
REVOKE ALL ON FUNCTION app_organizations_with_auto_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizations_with_auto_reminders() TO intuit_app;

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------

CREATE TABLE sales_order_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('order')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE sales_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  customer_id         uuid NOT NULL,
  order_date          date NOT NULL,
  expected_date       date,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED', 'CANCELLED')),
  reference           text CHECK (reference IS NULL OR length(reference) <= 100),
  memo                text NOT NULL DEFAULT '' CHECK (length(memo) <= 2000),
  net_total           numeric(28, 4) NOT NULL CHECK (net_total >= 0),
  cancel_reason       text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT sales_orders_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT sales_orders_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT sales_orders_cancel CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX sales_orders_number_idx ON sales_orders (organization_id, number);
CREATE INDEX sales_orders_list_idx ON sales_orders (organization_id, order_date DESC, id);

CREATE TABLE sales_order_lines (
  organization_id  uuid NOT NULL,
  order_id         uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  item_id          uuid,
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(28, 6) NOT NULL CHECK (unit_price >= 0),
  tax_code_id      uuid,
  net_amount       numeric(28, 4) NOT NULL CHECK (net_amount >= 0),
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT sales_order_lines_order_fkey FOREIGN KEY (order_id, organization_id)
    REFERENCES sales_orders (id, organization_id),
  CONSTRAINT sales_order_lines_item_fkey FOREIGN KEY (item_id, organization_id)
    REFERENCES sales_items (id, organization_id)
);

-- What each draft invoice took from an order. Deliberately no foreign key to the invoice: a draft
-- can be deleted, and the quantity is then simply no longer counted (see the service).
CREATE TABLE sales_order_invoice_lines (
  organization_id  uuid NOT NULL,
  order_id         uuid NOT NULL,
  line_no          integer NOT NULL,
  invoice_id       uuid NOT NULL,
  quantity         numeric(28, 6) NOT NULL CHECK (quantity > 0),
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (invoice_id, order_id, line_no),
  CONSTRAINT sales_order_invoice_lines_line_fkey FOREIGN KEY (order_id, line_no)
    REFERENCES sales_order_lines (order_id, line_no)
);
CREATE INDEX sales_order_invoice_lines_order_idx ON sales_order_invoice_lines (organization_id, order_id);
CREATE TRIGGER sales_order_invoice_lines_immutable BEFORE UPDATE OR DELETE ON sales_order_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

CREATE FUNCTION sales_guard_order() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'order % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cancelled order % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CONFIRMED' AND NEW.status NOT IN ('CONFIRMED', 'CANCELLED') THEN
    RAISE EXCEPTION 'confirmed order % cannot go back to draft', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CONFIRMED' AND (NEW.number, NEW.customer_id, NEW.order_date, NEW.net_total)
       IS DISTINCT FROM (OLD.number, OLD.customer_id, OLD.order_date, OLD.net_total) THEN
    RAISE EXCEPTION 'the content of confirmed order % is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_orders_guard BEFORE UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_guard_order();

CREATE FUNCTION sales_guard_order_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
BEGIN
  SELECT status INTO order_status FROM sales_orders
   WHERE id = COALESCE(OLD.order_id, NEW.order_id)
     AND organization_id = COALESCE(OLD.organization_id, NEW.organization_id);
  IF order_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the lines of an order that is not a draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER sales_order_lines_guard BEFORE UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_guard_order_line();

-- ---------------------------------------------------------------------------
-- Invoice share links (read-only customer view)
-- ---------------------------------------------------------------------------

CREATE TABLE invoice_share_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  -- SHA-256 of the token; the token itself is shown once and never stored.
  token_hash          text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid REFERENCES users (id),
  view_count          integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at      timestamptz,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT invoice_share_links_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id),
  CONSTRAINT invoice_share_links_expiry CHECK (expires_at > created_at)
);
CREATE INDEX invoice_share_links_invoice_idx ON invoice_share_links (organization_id, invoice_id, created_at DESC);

-- A link can only be revoked or counted; its target, token and expiry never change.
CREATE FUNCTION sales_guard_share_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'share links are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.invoice_id, NEW.token_hash, NEW.expires_at, NEW.created_at,
      NEW.created_by_user_id)
     IS DISTINCT FROM (OLD.organization_id, OLD.invoice_id, OLD.token_hash, OLD.expires_at,
      OLD.created_at, OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'share link % is immutable apart from revocation and views', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'share link % is already revoked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_share_links_guard BEFORE UPDATE OR DELETE ON invoice_share_links
  FOR EACH ROW EXECUTE FUNCTION sales_guard_share_link();

-- The one place a request WITHOUT a session reaches a tenant row: a token hash resolves to the
-- organization and invoice it opens, if the link is live. It returns nothing otherwise, and counts
-- the view. Ids only; the invoice is then read under that organization's row-level security.
CREATE FUNCTION app_open_invoice_share_link(hash text, now_at timestamptz)
  RETURNS TABLE (organization_id uuid, invoice_id uuid, link_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link invoice_share_links%ROWTYPE;
BEGIN
  SELECT * INTO link FROM invoice_share_links l
   WHERE l.token_hash = hash AND l.revoked_at IS NULL AND l.expires_at > now_at;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE invoice_share_links SET view_count = view_count + 1, last_viewed_at = now_at
   WHERE id = link.id;
  organization_id := link.organization_id;
  invoice_id := link.invoice_id;
  link_id := link.id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION app_open_invoice_share_link(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_open_invoice_share_link(text, timestamptz) TO intuit_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_reminder_settings', 'payment_reminders', 'sales_order_number_sequences', 'sales_orders',
    'sales_order_lines', 'sales_order_invoice_lines', 'invoice_share_links'
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

GRANT SELECT, INSERT, UPDATE ON payment_reminder_settings, sales_order_number_sequences, sales_orders,
  invoice_share_links TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_lines TO intuit_app;
GRANT DELETE ON sales_orders TO intuit_app;
GRANT SELECT, INSERT ON payment_reminders, sales_order_invoice_lines TO intuit_app;
