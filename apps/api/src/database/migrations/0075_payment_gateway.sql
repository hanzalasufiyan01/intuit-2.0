-- 0075_payment_gateway — online payment of issued invoices through a provider-neutral gateway.
--
-- * payment_gateway_settings: per organization, off by default. Mode `mock` is a deterministic
--   simulated provider for development and tests; `live` is reserved for a real provider that is
--   not configured anywhere yet (the application refuses it). The acting user is the member whose
--   permissions the system uses to record the receipt when a payment is confirmed.
-- * payment_intents: one attempt to collect one invoice. At most one open (CREATED or PENDING)
--   intent per invoice. SUCCEEDED requires a recorded receipt; a browser redirect never sets it.
-- * payment_events: the append-only ledger of provider events (webhook, reconciliation or sweep).
--   A provider event id is processed at most once (unique): the duplicate-webhook guard.
-- * Two narrow SECURITY DEFINER functions let a request without a session reach tenant rows:
--   resolving a provider reference to its intent, and listing stale pending intents for the sweep.

INSERT INTO permissions (key, module, description) VALUES
  ('payments.view', 'sales', 'View online payment attempts and the gateway settings'),
  ('payments.intents.create', 'sales', 'Start online payments for issued invoices'),
  ('payments.reconcile', 'sales', 'Check a payment attempt against the provider and record it'),
  ('payments.settings.manage', 'sales', 'Manage the online payment gateway settings')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE payments_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO payments_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('payments.view'), ('payments.intents.create'), ('payments.reconcile'), ('payments.settings.manage')
) AS p (key);

CREATE TEMPORARY TABLE payments_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN payments_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO payments_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0075_payment_gateway',
       jsonb_build_object(
         'reason', 'Payment gateway permission backfill',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM payments_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

CREATE TABLE payment_gateway_settings (
  organization_id     uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  mode                text NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'mock', 'live')),
  acting_user_id      uuid NOT NULL REFERENCES users (id),
  intent_ttl_minutes  integer NOT NULL DEFAULT 60 CHECK (intent_ttl_minutes BETWEEN 5 AND 10080),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL
);

CREATE TABLE payment_intents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  customer_id         uuid NOT NULL,
  amount              numeric(28, 4) NOT NULL CHECK (amount > 0),
  currency_code       char(3) NOT NULL,
  provider            text NOT NULL CHECK (provider IN ('mock')),
  mode                text NOT NULL CHECK (mode IN ('mock', 'live')),
  provider_ref        text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 3 AND 200),
  checkout_url        text CHECK (checkout_url IS NULL OR length(checkout_url) <= 2000),
  status              text NOT NULL DEFAULT 'CREATED' CHECK (status IN
                        ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REQUIRES_REVIEW')),
  failure_code        text CHECK (failure_code IS NULL OR length(failure_code) <= 100),
  receipt_id          uuid,
  share_link_id       uuid,
  created_by_user_id  uuid REFERENCES users (id),
  expires_at          timestamptz NOT NULL,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  CONSTRAINT payment_intents_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payment_intents_invoice_fkey FOREIGN KEY (invoice_id, organization_id)
    REFERENCES sales_invoices (id, organization_id),
  CONSTRAINT payment_intents_receipt_fkey FOREIGN KEY (receipt_id, organization_id)
    REFERENCES sales_receipts (id, organization_id),
  CONSTRAINT payment_intents_receipt_iff_succeeded CHECK ((status = 'SUCCEEDED') = (receipt_id IS NOT NULL))
);
CREATE UNIQUE INDEX payment_intents_provider_ref_idx ON payment_intents (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX payment_intents_one_open_idx ON payment_intents (organization_id, invoice_id)
  WHERE status IN ('CREATED', 'PENDING');
CREATE UNIQUE INDEX payment_intents_receipt_idx ON payment_intents (receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX payment_intents_list_idx ON payment_intents (organization_id, created_at DESC, id);
CREATE INDEX payment_intents_sweep_idx ON payment_intents (created_at) WHERE status = 'PENDING';

CREATE FUNCTION payments_guard_intent() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment intents are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.invoice_id, NEW.customer_id, NEW.amount, NEW.currency_code,
      NEW.provider, NEW.mode, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.invoice_id, OLD.customer_id, OLD.amount,
      OLD.currency_code, OLD.provider, OLD.mode, OLD.created_at) THEN
    RAISE EXCEPTION 'the terms of payment intent % are fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'the provider reference of payment intent % is fixed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'succeeded payment intent % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Money received is always recorded: a failed, cancelled or expired attempt can still turn out
  -- to have been paid (late or out-of-order provider events).
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'CREATED' AND NEW.status IN ('PENDING', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REQUIRES_REVIEW'))
    OR (OLD.status = 'REQUIRES_REVIEW' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    OR (OLD.status IN ('FAILED', 'CANCELLED', 'EXPIRED') AND NEW.status IN ('SUCCEEDED', 'REQUIRES_REVIEW'))
  ) THEN
    RAISE EXCEPTION 'payment intent % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_intents_guard BEFORE UPDATE OR DELETE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payments_guard_intent();

CREATE TABLE payment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  intent_id          uuid NOT NULL,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  event_type         text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  source             text NOT NULL CHECK (source IN ('webhook', 'reconcile', 'sweep')),
  amount             numeric(28, 4),
  currency_code      char(3),
  outcome            text NOT NULL CHECK (outcome IN ('applied', 'ignored', 'rejected', 'failed')),
  detail             text CHECK (detail IS NULL OR length(detail) <= 500),
  payload_hash       text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at        timestamptz NOT NULL,
  CONSTRAINT payment_events_intent_fkey FOREIGN KEY (intent_id, organization_id)
    REFERENCES payment_intents (id, organization_id)
);
CREATE UNIQUE INDEX payment_events_once_idx ON payment_events (provider, provider_event_id);
CREATE INDEX payment_events_intent_idx ON payment_events (organization_id, intent_id, received_at);
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

CREATE FUNCTION app_payment_intent_lookup(p_provider text, p_ref text)
  RETURNS TABLE (organization_id uuid, intent_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT organization_id, id FROM payment_intents WHERE provider = p_provider AND provider_ref = p_ref
$$;
REVOKE ALL ON FUNCTION app_payment_intent_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_payment_intent_lookup(text, text) TO intuit_app;

CREATE FUNCTION app_stale_payment_intents(older_than timestamptz, max_rows integer)
  RETURNS TABLE (organization_id uuid, intent_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT organization_id, id FROM payment_intents
   WHERE status = 'PENDING' AND created_at < older_than
   ORDER BY created_at LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION app_stale_payment_intents(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_stale_payment_intents(timestamptz, integer) TO intuit_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_gateway_settings', 'payment_intents', 'payment_events'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON payment_gateway_settings, payment_intents TO intuit_app;
GRANT SELECT, INSERT ON payment_events TO intuit_app;
