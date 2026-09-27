-- Intuit 2.0 — Phase 1 foundation schema.
--
-- Runs as the migration role (intuit_owner), which owns every object created here.
-- The runtime role intuit_app receives explicit, least-privilege grants at the end.
--
-- Module ownership of tables:
--   identity        users, sessions, password_reset_tokens
--   organizations   organizations, memberships, invitations, ownership_transfers
--   access-control  permissions, role_templates, role_template_permissions,
--                   roles, role_permissions, membership_roles
--   audit           audit_events, security_events
--   outbox          outbox_events
--
-- Row-Level Security is defence-in-depth only; application authorization is always enforced.
-- RLS is ENABLED (not FORCED), so it constrains intuit_app while the owning migration role
-- and SECURITY DEFINER helpers owned by it are not subject to the policies.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Request context, set per transaction by the application with set_config(..., true).
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION app_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Rejects any modification of append-only history tables, for every role.
CREATE FUNCTION app_reject_history_modification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_normalized    text NOT NULL CHECK (email_normalized = lower(btrim(email_normalized))),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  password_hash       text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at   timestamptz,
  password_changed_at timestamptz NOT NULL,
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized_key UNIQUE (email_normalized),
  CONSTRAINT users_disabled_consistency CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- ---------------------------------------------------------------------------
-- organizations (tenant root)
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_touch_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- ---------------------------------------------------------------------------
-- identity: sessions and password reset tokens
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the opaque session token. The raw token only ever exists in the cookie.
  token_hash             bytea NOT NULL CHECK (length(token_hash) = 32),
  -- Preferred organization; membership is re-verified on every request.
  active_organization_id uuid REFERENCES organizations (id),
  created_at             timestamptz NOT NULL,
  last_seen_at           timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  reauthenticated_at     timestamptz NOT NULL,
  revoked_at             timestamptz,
  revoked_reason         text CHECK (revoked_reason IN
                           ('logout', 'user_revoked', 'password_reset', 'account_disabled', 'expired')),
  ip_address             text,
  user_agent             text,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT sessions_revocation_consistency CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the token. Raw tokens are never stored.
  token_hash   bytea NOT NULL CHECK (length(token_hash) = 32),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip text,
  CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_tokens_user_unused_idx ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- organizations: memberships
-- ---------------------------------------------------------------------------

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_organization_user_key UNIQUE (organization_id, user_id),
  -- Target for composite foreign keys that pin children to the same organization.
  CONSTRAINT memberships_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT memberships_disabled_consistency CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE TRIGGER memberships_touch_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- ---------------------------------------------------------------------------
-- access-control
-- ---------------------------------------------------------------------------

-- Global permission catalog. Modules contribute entries; seeded by the migration role.
CREATE TABLE permissions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  module      text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Approved rule: financial records are never physically deleted.
  -- Use invoices.delete_draft and invoices.void instead.
  CONSTRAINT permissions_no_invoice_delete CHECK (key <> 'invoices.delete')
);

-- System role templates from which every organization's roles are provisioned.
CREATE TABLE role_templates (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text NOT NULL,
  description text NOT NULL,
  is_owner    boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL
);
CREATE UNIQUE INDEX role_templates_single_owner_idx ON role_templates (is_owner) WHERE is_owner;

CREATE TABLE role_template_permissions (
  template_key   text NOT NULL REFERENCES role_templates (key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key),
  PRIMARY KEY (template_key, permission_key)
);

-- Organization-scoped roles.
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  template_key    text REFERENCES role_templates (key),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  is_system       boolean NOT NULL DEFAULT false,
  is_owner        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT roles_id_organization_owner_key UNIQUE (id, organization_id, is_owner),
  CONSTRAINT roles_organization_template_key UNIQUE (organization_id, template_key),
  CONSTRAINT roles_system_has_template CHECK (is_system = (template_key IS NOT NULL)),
  CONSTRAINT roles_owner_is_system CHECK (NOT is_owner OR is_system)
);
CREATE UNIQUE INDEX roles_organization_name_idx ON roles (organization_id, lower(name));
CREATE UNIQUE INDEX roles_single_owner_role_idx ON roles (organization_id) WHERE is_owner;
CREATE TRIGGER roles_touch_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL,
  organization_id uuid NOT NULL,
  permission_key  text NOT NULL REFERENCES permissions (key),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT role_permissions_role_fkey FOREIGN KEY (role_id, organization_id)
    REFERENCES roles (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX role_permissions_organization_idx ON role_permissions (organization_id);

CREATE TABLE membership_roles (
  membership_id       uuid NOT NULL,
  role_id             uuid NOT NULL,
  organization_id     uuid NOT NULL,
  -- Mirrors roles.is_owner (enforced by the composite foreign key) so that the
  -- "exactly one Owner per organization" rule can be a unique index.
  role_is_owner       boolean NOT NULL,
  assigned_by_user_id uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id),
  CONSTRAINT membership_roles_membership_fkey FOREIGN KEY (membership_id, organization_id)
    REFERENCES memberships (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT membership_roles_role_fkey FOREIGN KEY (role_id, organization_id, role_is_owner)
    REFERENCES roles (id, organization_id, is_owner)
);
CREATE UNIQUE INDEX membership_roles_single_owner_idx ON membership_roles (organization_id)
  WHERE role_is_owner;
CREATE INDEX membership_roles_role_idx ON membership_roles (role_id);

-- ---------------------------------------------------------------------------
-- organizations: invitations and ownership transfers
-- ---------------------------------------------------------------------------

CREATE TABLE invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  email               text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_normalized    text NOT NULL CHECK (email_normalized = lower(btrim(email_normalized))),
  role_id             uuid NOT NULL,
  -- Always false: the Owner role can never be granted by invitation.
  role_is_owner       boolean NOT NULL DEFAULT false CHECK (NOT role_is_owner),
  invited_by_user_id  uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the invitation token. Raw tokens are never stored.
  token_hash          bytea NOT NULL CHECK (length(token_hash) = 32),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_by_user_id uuid REFERENCES users (id),
  revoked_at          timestamptz,
  revoked_by_user_id  uuid REFERENCES users (id),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_role_fkey FOREIGN KEY (role_id, organization_id, role_is_owner)
    REFERENCES roles (id, organization_id, is_owner),
  CONSTRAINT invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT invitations_accepted_consistency
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)),
  CONSTRAINT invitations_revoked_consistency
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX invitations_single_pending_idx ON invitations (organization_id, email_normalized)
  WHERE status = 'pending';
CREATE INDEX invitations_organization_created_idx ON invitations (organization_id, created_at DESC);

-- Data model for the controlled ownership-transfer workflow
-- (initiate -> security verification -> acceptance -> completion).
-- The workflow itself is not built in Phase 1; there is no direct owner reassignment.
CREATE TABLE ownership_transfers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id),
  from_membership_id   uuid NOT NULL,
  to_membership_id     uuid NOT NULL,
  replacement_role_id  uuid NOT NULL,
  initiated_by_user_id uuid NOT NULL REFERENCES users (id),
  status               text NOT NULL DEFAULT 'initiated'
                         CHECK (status IN ('initiated', 'verified', 'accepted', 'completed',
                                           'cancelled', 'expired')),
  initiated_at         timestamptz NOT NULL,
  verified_at          timestamptz,
  accepted_at          timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  CONSTRAINT ownership_transfers_from_fkey FOREIGN KEY (from_membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  CONSTRAINT ownership_transfers_to_fkey FOREIGN KEY (to_membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  CONSTRAINT ownership_transfers_replacement_role_fkey FOREIGN KEY (replacement_role_id, organization_id)
    REFERENCES roles (id, organization_id),
  CONSTRAINT ownership_transfers_distinct_members CHECK (from_membership_id <> to_membership_id)
);
CREATE UNIQUE INDEX ownership_transfers_single_open_idx ON ownership_transfers (organization_id)
  WHERE status IN ('initiated', 'verified', 'accepted');

-- ---------------------------------------------------------------------------
-- audit (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL,
  organization_id uuid REFERENCES organizations (id),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'system', 'anonymous')),
  actor_user_id   uuid REFERENCES users (id),
  action          text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type   text NOT NULL,
  resource_id     text,
  request_id      text,
  ip_address      text,
  user_agent      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_events_actor_consistency CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL))
);
CREATE INDEX audit_events_organization_time_idx ON audit_events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx ON audit_events (actor_user_id, occurred_at DESC);

CREATE TABLE security_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at      timestamptz NOT NULL,
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  user_id          uuid REFERENCES users (id),
  organization_id  uuid REFERENCES organizations (id),
  -- Normalized email of the account an anonymous attempt targeted (e.g. failed login).
  email_normalized text,
  ip_address       text,
  user_agent       text,
  request_id       text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX security_events_user_time_idx ON security_events (user_id, occurred_at DESC);
CREATE INDEX security_events_login_failed_email_idx ON security_events (email_normalized, occurred_at)
  WHERE event_type = 'auth.login_failed';
CREATE INDEX security_events_login_failed_ip_idx ON security_events (ip_address, occurred_at)
  WHERE event_type = 'auth.login_failed';

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER security_events_no_truncate BEFORE TRUNCATE ON security_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- ---------------------------------------------------------------------------
-- outbox
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  organization_id uuid REFERENCES organizations (id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  available_at    timestamptz NOT NULL,
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  created_at      timestamptz NOT NULL,
  processed_at    timestamptz,
  CONSTRAINT outbox_events_processed_consistency CHECK ((status = 'processed') = (processed_at IS NOT NULL)),
  CONSTRAINT outbox_events_lock_consistency CHECK ((status = 'processing') = (locked_at IS NOT NULL))
);
CREATE INDEX outbox_events_dispatch_idx ON outbox_events (available_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security (defence-in-depth for tenant isolation)
-- ---------------------------------------------------------------------------

ALTER TABLE organizations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships         ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ownership_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events        ENABLE ROW LEVEL SECURITY;

-- A user sees organizations they are an active member of; writes need the matching context.
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (
    id = app_current_organization_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.organization_id = organizations.id
        AND m.user_id = app_current_user_id()
        AND m.status = 'active'
    )
  );
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (id = app_current_organization_id());
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = app_current_organization_id())
  WITH CHECK (id = app_current_organization_id());

-- Memberships: full access inside the active organization; a user can also list their own.
CREATE POLICY memberships_tenant ON memberships FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY memberships_own_select ON memberships FOR SELECT
  USING (user_id = app_current_user_id());

CREATE POLICY roles_tenant ON roles FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY role_permissions_tenant ON role_permissions FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY membership_roles_tenant ON membership_roles FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY invitations_tenant ON invitations FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY ownership_transfers_tenant ON ownership_transfers FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- Audit: organization events are visible only inside that organization.
-- Events without an organization (e.g. sign-in) can be written but not read by the app role.
CREATE POLICY audit_events_select ON audit_events FOR SELECT
  USING (organization_id = app_current_organization_id());
CREATE POLICY audit_events_insert ON audit_events FOR INSERT
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_organization_id());

-- Resolves an invitation token hash to its organization before any organization context exists.
-- Returns only identifiers; the caller then reads the invitation under that organization's context.
CREATE FUNCTION app_resolve_invitation_token(p_token_hash bytea)
  RETURNS TABLE (invitation_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.organization_id FROM public.invitations i WHERE i.token_hash = p_token_hash
  $$;
REVOKE ALL ON FUNCTION app_resolve_invitation_token(bytea) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants for the runtime application role (least privilege)
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON users, sessions, password_reset_tokens TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON organizations, memberships, invitations TO intuit_app;
GRANT SELECT ON ownership_transfers TO intuit_app;
GRANT SELECT ON permissions, role_templates, role_template_permissions TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON roles, role_permissions, membership_roles TO intuit_app;
-- History tables: append and read only.
GRANT SELECT, INSERT ON audit_events, security_events TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO intuit_app;

GRANT EXECUTE ON FUNCTION app_current_user_id(), app_current_organization_id() TO intuit_app;
GRANT EXECUTE ON FUNCTION app_resolve_invitation_token(bytea) TO intuit_app;
