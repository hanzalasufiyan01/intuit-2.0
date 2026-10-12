-- 0058_webhooks — webhook endpoints, subscriptions, deliveries and attempts (ADR 0011 sections
-- 11 and 19; Step 6).
--
-- * An endpoint belongs to an organization and to one API integration: its subscriptions can never
--   exceed what that integration may read (checked in code at subscribe, fan-out and delivery).
-- * The signing secret is stored ENCRYPTED (AES-256-GCM, key id + iv + tag + ciphertext), with the
--   previous secret kept only for the configured overlap. It is never stored in clear and never in
--   the delivery history.
-- * One delivery per (event, endpoint); one attempt row per try. The history never contains the
--   secret or the request signature.
-- * Tenant tables: composite foreign keys, RLS, no TRUNCATE, no PUBLIC grants. Three narrow
--   SECURITY DEFINER functions serve the cross-organization maintenance (retention, stale sweep).

-- ---------------------------------------------------------------------------
-- Event type catalog (the 27 frozen v1 types; additive only)
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_event_types (
  type     text PRIMARY KEY CHECK (type ~ '^[a-z_]+\.[a-z_]+$'),
  resource text NOT NULL
);
INSERT INTO webhook_event_types (type, resource) VALUES
  ('customer.created', 'customer'), ('customer.updated', 'customer'), ('customer.archived', 'customer'),
  ('vendor.created', 'vendor'), ('vendor.updated', 'vendor'), ('vendor.archived', 'vendor'),
  ('item.created', 'item'), ('item.updated', 'item'), ('item.archived', 'item'),
  ('invoice.issued', 'invoice'), ('invoice.voided', 'invoice'),
  ('credit_note.issued', 'credit_note'),
  ('receipt.recorded', 'receipt'), ('receipt.voided', 'receipt'),
  ('customer_refund.recorded', 'customer_refund'), ('customer_refund.voided', 'customer_refund'),
  ('bill.posted', 'bill'), ('bill.voided', 'bill'),
  ('vendor_credit.posted', 'vendor_credit'), ('vendor_credit.voided', 'vendor_credit'),
  ('vendor_payment.recorded', 'vendor_payment'), ('vendor_payment.voided', 'vendor_payment'),
  ('vendor_refund.recorded', 'vendor_refund'), ('vendor_refund.voided', 'vendor_refund'),
  ('expense_claim.posted', 'expense_claim'), ('expense_claim.voided', 'expense_claim'),
  ('webhook.ping', 'webhook');
REVOKE ALL ON webhook_event_types FROM PUBLIC;
GRANT SELECT ON webhook_event_types TO intuit_app;

-- ---------------------------------------------------------------------------
-- Endpoints and subscriptions
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_endpoints (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id),
  integration_id          uuid NOT NULL,
  name                    text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  url                     text NOT NULL CHECK (length(url) <= 2048 AND url ~ '^https://'),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'auto_disabled')),
  api_version             text NOT NULL DEFAULT 'v1' CHECK (api_version = 'v1'),
  payload_mode            text NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin', 'full')),
  -- Current signing secret (encrypted); `secret_version` binds the ciphertext to this rotation.
  secret_version          integer NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  secret_key_id           text NOT NULL,
  secret_iv               bytea NOT NULL,
  secret_tag              bytea NOT NULL,
  secret_ciphertext       bytea NOT NULL,
  -- Previous secret, valid until `prev_secret_expires_at` (rotation overlap).
  prev_secret_key_id      text,
  prev_secret_iv          bytea,
  prev_secret_tag         bytea,
  prev_secret_ciphertext  bytea,
  prev_secret_expires_at  timestamptz,
  consecutive_failures    integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at         timestamptz,
  last_failure_at         timestamptz,
  -- Delivery throttling: bounded concurrency and a minimum spacing between sends.
  in_flight               integer NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  in_flight_until         timestamptz,
  next_send_at            timestamptz,
  -- Re-enabling needs a successful ping after the endpoint was disabled.
  ping_verified_at        timestamptz,
  disabled_at             timestamptz,
  disabled_by_user_id     uuid REFERENCES users (id),
  disabled_reason         text CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 500),
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id      uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL,
  updated_by_user_id      uuid REFERENCES users (id),
  updated_at              timestamptz NOT NULL,
  deleted_at              timestamptz,
  deleted_by_user_id      uuid REFERENCES users (id),
  CONSTRAINT webhook_endpoints_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT webhook_endpoints_integration_fkey FOREIGN KEY (integration_id, organization_id)
    REFERENCES api_integrations (id, organization_id),
  CONSTRAINT webhook_endpoints_prev_secret_consistency CHECK (
    (prev_secret_key_id IS NULL) = (prev_secret_ciphertext IS NULL)
    AND (prev_secret_key_id IS NULL) = (prev_secret_iv IS NULL)
    AND (prev_secret_key_id IS NULL) = (prev_secret_tag IS NULL)
    AND (prev_secret_key_id IS NULL) = (prev_secret_expires_at IS NULL)),
  CONSTRAINT webhook_endpoints_disabled_consistency CHECK (
    (status = 'active') = (disabled_at IS NULL))
);
CREATE UNIQUE INDEX webhook_endpoints_name_idx ON webhook_endpoints (organization_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX webhook_endpoints_active_idx ON webhook_endpoints (organization_id)
  WHERE deleted_at IS NULL AND status = 'active';

CREATE TABLE webhook_subscriptions (
  endpoint_id     uuid NOT NULL,
  organization_id uuid NOT NULL,
  event_type      text NOT NULL REFERENCES webhook_event_types (type),
  created_at      timestamptz NOT NULL,
  PRIMARY KEY (endpoint_id, event_type),
  CONSTRAINT webhook_subscriptions_endpoint_fkey FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES webhook_endpoints (id, organization_id),
  CONSTRAINT webhook_subscriptions_no_ping CHECK (event_type <> 'webhook.ping')
);
CREATE INDEX webhook_subscriptions_type_idx ON webhook_subscriptions (organization_id, event_type);

-- At most 10 endpoints per organization (deleted ones do not count); serialized per organization.
CREATE FUNCTION webhook_endpoints_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('webhook_endpoints:' || NEW.organization_id::text, 0));
    IF (SELECT count(*) FROM webhook_endpoints
         WHERE organization_id = NEW.organization_id AND deleted_at IS NULL) >= 10 THEN
      RAISE EXCEPTION 'an organization can have at most 10 webhook endpoints'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.id, NEW.organization_id, NEW.integration_id, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.integration_id, OLD.created_by_user_id, OLD.created_at) THEN
      RAISE EXCEPTION 'the identity of webhook endpoint % cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'webhook endpoint % is deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_endpoints_guard BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_guard();

-- ---------------------------------------------------------------------------
-- Deliveries and attempts (the delivery history)
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_deliveries (
  -- The delivery id: the `Intuit-Webhook-Id` header, stable across retries and redelivery.
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  -- The immutable event id (`evt_…`), the consumer's de-duplication key.
  event_id         text NOT NULL,
  event_type       text NOT NULL REFERENCES webhook_event_types (type),
  -- The outbox row this delivery was fanned out from (null for a ping): fan-out is idempotent.
  outbox_event_id  uuid,
  resource_type    text NOT NULL,
  resource_id      text NOT NULL,
  -- The public event envelope (thin form); `full` endpoints get `data.object` added at send time.
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'dead', 'cancelled')),
  attempts_made    integer NOT NULL DEFAULT 0 CHECK (attempts_made >= 0),
  cycle_attempts   integer NOT NULL DEFAULT 0 CHECK (cycle_attempts >= 0),
  redelivery_count integer NOT NULL DEFAULT 0 CHECK (redelivery_count >= 0),
  last_status_code integer,
  last_error_class text,
  created_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  CONSTRAINT webhook_deliveries_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT webhook_deliveries_endpoint_fkey FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES webhook_endpoints (id, organization_id),
  CONSTRAINT webhook_deliveries_finished_consistency CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX webhook_deliveries_fanout_idx ON webhook_deliveries (outbox_event_id, endpoint_id)
  WHERE outbox_event_id IS NOT NULL;
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (organization_id, endpoint_id, created_at DESC);
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (endpoint_id) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_finished_idx ON webhook_deliveries (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE webhook_delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  delivery_id      uuid NOT NULL,
  attempt_no       integer NOT NULL CHECK (attempt_no >= 1),
  started_at       timestamptz NOT NULL,
  duration_ms      integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status_code      integer,
  error_class      text,
  -- At most 1 KB of the response, control characters removed. Never a secret or a signature.
  response_excerpt text CHECK (response_excerpt IS NULL OR length(response_excerpt) <= 1024),
  CONSTRAINT webhook_delivery_attempts_delivery_fkey FOREIGN KEY (delivery_id, organization_id)
    REFERENCES webhook_deliveries (id, organization_id),
  CONSTRAINT webhook_delivery_attempts_no_key UNIQUE (delivery_id, attempt_no)
);

-- ---------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints', 'webhook_subscriptions', 'webhook_deliveries',
                           'webhook_delivery_attempts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints, webhook_deliveries TO intuit_app;
GRANT SELECT, INSERT, DELETE ON webhook_subscriptions TO intuit_app;
GRANT SELECT, INSERT ON webhook_delivery_attempts TO intuit_app;

-- ---------------------------------------------------------------------------
-- Cross-organization maintenance (narrow, identifiers and counts only)
-- ---------------------------------------------------------------------------

-- Organizations with at least one live endpoint (the sweep for stale endpoints runs per tenant).
CREATE FUNCTION app_organizations_with_webhooks() RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT DISTINCT e.organization_id FROM public.webhook_endpoints e
     WHERE e.deleted_at IS NULL AND e.status = 'active'
  $$;

-- Deletes the delivery history of finished deliveries older than the retention cutoff (attempts
-- first), in bounded batches; pending deliveries are never touched.
CREATE FUNCTION app_purge_webhook_history(p_cutoff timestamptz, p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  purged integer;
BEGIN
  WITH doomed AS (
    SELECT d.id FROM public.webhook_deliveries d
     WHERE d.finished_at IS NOT NULL AND d.finished_at < p_cutoff
     ORDER BY d.finished_at LIMIT p_limit),
  gone_attempts AS (
    DELETE FROM public.webhook_delivery_attempts a USING doomed WHERE a.delivery_id = doomed.id
    RETURNING 1)
  DELETE FROM public.webhook_deliveries d USING doomed WHERE d.id = doomed.id;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

-- Deletes processed (or failed) PUBLIC outbox rows older than the cutoff; no other event type.
CREATE FUNCTION app_purge_public_outbox(p_cutoff timestamptz, p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  purged integer;
BEGIN
  DELETE FROM public.outbox_events o
   WHERE o.id IN (SELECT id FROM public.outbox_events
                   WHERE event_type LIKE 'public.%' AND status IN ('processed', 'failed')
                     AND created_at < p_cutoff
                   ORDER BY created_at LIMIT p_limit);
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION webhook_endpoints_guard(), app_organizations_with_webhooks(),
  app_purge_webhook_history(timestamptz, integer), app_purge_public_outbox(timestamptz, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizations_with_webhooks(),
  app_purge_webhook_history(timestamptz, integer), app_purge_public_outbox(timestamptz, integer)
  TO intuit_app;
