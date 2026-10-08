-- 0056_api_integrations — organization-owned API integrations and tokens (ADR 0011, D2; Step 2).
--
-- * An integration is owned by the ORGANIZATION. Its runtime identity is a non-human service
--   principal (users.kind = 'service', migration 0053) with its single membership; the
--   responsible administrator is a separate, reassignable human relationship.
-- * Scopes are explicit grants (rows), bounded in code by the fixed platform Public API policy.
--   There is no per-organization API policy table.
-- * A token is an opaque credential `itk_<public_id>_<secret>`: only SHA-256(secret) is stored,
--   expiry is mandatory and at most 365 days, revocation is terminal. A token is not a user.
-- * Tenant tables: composite foreign keys, RLS, no TRUNCATE, no PUBLIC grants.

CREATE TABLE api_integrations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations (id),
  name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description               text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  -- The non-human identity and its single membership (0053 enforces one organization).
  service_user_id           uuid NOT NULL REFERENCES users (id),
  service_membership_id     uuid NOT NULL,
  -- A human, reassignable; may not be a service principal.
  responsible_membership_id uuid NOT NULL,
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id        uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL,
  updated_by_user_id        uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL,
  disabled_at               timestamptz,
  disabled_by_user_id       uuid REFERENCES users (id),
  revoked_at                timestamptz,
  revoked_by_user_id        uuid REFERENCES users (id),
  revoke_reason             text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CONSTRAINT api_integrations_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT api_integrations_service_user_key UNIQUE (service_user_id),
  CONSTRAINT api_integrations_service_membership_key UNIQUE (service_membership_id),
  CONSTRAINT api_integrations_service_membership_fkey FOREIGN KEY (service_membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  CONSTRAINT api_integrations_responsible_fkey FOREIGN KEY (responsible_membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  CONSTRAINT api_integrations_disabled_consistency CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CONSTRAINT api_integrations_revoked_consistency CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
    AND (status <> 'revoked' OR (revoke_reason IS NOT NULL AND revoked_by_user_id IS NOT NULL)))
);
CREATE UNIQUE INDEX api_integrations_name_idx ON api_integrations (organization_id, lower(name))
  WHERE status <> 'revoked';
CREATE INDEX api_integrations_responsible_idx ON api_integrations (organization_id, responsible_membership_id);

CREATE TABLE api_integration_scopes (
  integration_id     uuid NOT NULL,
  organization_id    uuid NOT NULL,
  scope              text NOT NULL CHECK (scope ~ '^[a-z][a-z_]*:(read|write)$'),
  granted_by_user_id uuid NOT NULL REFERENCES users (id),
  granted_at         timestamptz NOT NULL,
  PRIMARY KEY (integration_id, scope),
  CONSTRAINT api_integration_scopes_integration_fkey FOREIGN KEY (integration_id, organization_id)
    REFERENCES api_integrations (id, organization_id)
);

CREATE TABLE api_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  integration_id     uuid NOT NULL,
  -- The public, non-secret part of the credential; looked up before any tenant context exists.
  public_id          text NOT NULL CHECK (public_id ~ '^[a-z0-9]{8}$'),
  -- SHA-256 of the secret part; the secret itself is shown once and never stored.
  secret_hash        bytea NOT NULL CHECK (length(secret_hash) = 32),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  replaces_token_id  uuid,
  last_used_at       timestamptz,
  last_used_ip       text,
  revoked_at         timestamptz,
  revoked_by_user_id uuid REFERENCES users (id),
  revoke_reason      text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CONSTRAINT api_tokens_public_id_key UNIQUE (public_id),
  CONSTRAINT api_tokens_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT api_tokens_integration_fkey FOREIGN KEY (integration_id, organization_id)
    REFERENCES api_integrations (id, organization_id),
  CONSTRAINT api_tokens_replaces_fkey FOREIGN KEY (replaces_token_id, organization_id)
    REFERENCES api_tokens (id, organization_id),
  CONSTRAINT api_tokens_mandatory_expiry CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '365 days'),
  CONSTRAINT api_tokens_revocation_consistency CHECK (
    (revoked_at IS NULL) = (revoke_reason IS NULL) AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
CREATE INDEX api_tokens_integration_idx ON api_tokens (organization_id, integration_id, created_at DESC);
CREATE INDEX api_tokens_active_idx ON api_tokens (organization_id, expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The service membership must be the membership of the integration's own service principal;
-- the responsible administrator must be a human (a service principal can never be one).
CREATE FUNCTION api_integrations_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
          WHERE m.id = NEW.service_membership_id AND m.user_id = NEW.service_user_id
            AND m.organization_id = NEW.organization_id AND u.kind = 'service') THEN
      RAISE EXCEPTION 'an integration needs the membership of its own service principal'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD.status = 'revoked' THEN
      RAISE EXCEPTION 'revoked integration % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.id, NEW.organization_id, NEW.service_user_id, NEW.service_membership_id,
        NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.service_user_id, OLD.service_membership_id,
        OLD.created_by_user_id, OLD.created_at) THEN
      RAISE EXCEPTION 'the identity of integration % cannot change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
        WHERE m.id = NEW.responsible_membership_id AND u.kind = 'service') THEN
    RAISE EXCEPTION 'the responsible administrator must be a human' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_integrations_guard BEFORE INSERT OR UPDATE ON api_integrations
  FOR EACH ROW EXECUTE FUNCTION api_integrations_guard();

-- A token's credential and lifetime never change; revocation is terminal.
CREATE FUNCTION api_tokens_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.integration_id, NEW.public_id, NEW.secret_hash, NEW.name,
      NEW.created_by_user_id, NEW.created_at, NEW.expires_at, NEW.replaces_token_id)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.integration_id, OLD.public_id, OLD.secret_hash, OLD.name,
      OLD.created_by_user_id, OLD.created_at, OLD.expires_at, OLD.replaces_token_id) THEN
    RAISE EXCEPTION 'the credential of API token % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by_user_id, NEW.revoke_reason)
       IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_user_id, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'API token % is already revoked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_tokens_guard BEFORE UPDATE ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION api_tokens_guard();

-- ---------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_integrations', 'api_integration_scopes', 'api_tokens'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON api_integrations, api_tokens TO intuit_app;
GRANT SELECT, INSERT, DELETE ON api_integration_scopes TO intuit_app;

-- Resolves the public part of a token to its organization and service principal before any
-- tenant context exists (the same pattern as invitation tokens). It returns identifiers only; the
-- secret is verified afterwards under that organization's context.
CREATE FUNCTION app_resolve_api_token(p_public_id text)
  RETURNS TABLE (token_id uuid, organization_id uuid, service_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.organization_id, i.service_user_id
      FROM public.api_tokens t JOIN public.api_integrations i
        ON i.id = t.integration_id AND i.organization_id = t.organization_id
     WHERE t.public_id = p_public_id
  $$;
REVOKE ALL ON FUNCTION app_resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_api_token(text) TO intuit_app;
REVOKE ALL ON FUNCTION api_integrations_guard(), api_tokens_guard() FROM PUBLIC;
