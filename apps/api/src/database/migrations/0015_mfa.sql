-- 0015_mfa — Phase 3A S7: multi-factor authentication.
-- Decisions 5, 25, 49, 57, 72 (refined by S7-37), 76; S7-01 to S7-46 (ADR 0003).
--
-- * sessions gain the MFA-pending state and how the session satisfied MFA (S7-03, S7-14).
--   Existing sessions are not MFA-verified; privileged users are enforced on their next
--   request (S7-30).
-- * mfa_factors, mfa_recovery_codes and trusted_devices are user-scoped (one identity:
--   users.id), with user-keyed RLS (S7-07). TOTP secrets are stored only AES-256-GCM encrypted
--   (S7-09); recovery codes only as Argon2id (S7-18); device tokens only as SHA-256 (S7-34).
-- * organization_security_policies holds "require MFA for all members" and
--   "allow remembered devices" (S7-29, S7-36), with tenant RLS.
-- * Narrow SECURITY DEFINER functions: member enrollment status for administrators (S7-39)
--   and the admin MFA reset with its Owner, self and cross-tenant refusals (S7-37, S7-38).
-- No permission keys are added (S7-40).

-- ---------------------------------------------------------------------------
-- sessions: MFA state
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  -- Non-null while the session waits for the second factor (default-deny, S7-15).
  ADD COLUMN mfa_pending_until   timestamptz,
  -- How the session satisfied MFA; NULL = not satisfied.
  ADD COLUMN mfa_method          text CHECK (mfa_method IN ('totp', 'recovery_code', 'trusted_device')),
  -- Last time a real factor was entered in this session (step-up freshness, S7-33).
  ADD COLUMN mfa_verified_at     timestamptz,
  ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0 CHECK (mfa_failed_attempts >= 0),
  ADD CONSTRAINT sessions_mfa_pending_unsatisfied CHECK (mfa_pending_until IS NULL OR mfa_method IS NULL),
  ADD CONSTRAINT sessions_mfa_verified_by_factor CHECK (mfa_verified_at IS NULL OR mfa_method IN ('totp', 'recovery_code'));

ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
  ('logout', 'user_revoked', 'password_reset', 'account_disabled', 'expired', 'mfa_failed', 'mfa_reset'));

-- ---------------------------------------------------------------------------
-- mfa_factors (TOTP now; WebAuthn later adds its own detail table, S7-02)
-- ---------------------------------------------------------------------------

CREATE TABLE mfa_factors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id),
  type               text NOT NULL CHECK (type IN ('totp')),
  status             text NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  label              text CHECK (length(label) <= 100),
  -- AES-256-GCM: ciphertext, 96-bit IV, 128-bit tag, and the id of the sealing key.
  secret_ciphertext  bytea,
  secret_iv          bytea,
  secret_tag         bytea,
  key_id             text CHECK (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  -- Replay protection: the last accepted RFC 6238 time step (S7-16).
  last_used_step     bigint,
  failed_attempts    integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  pending_expires_at timestamptz,
  created_at         timestamptz NOT NULL,
  activated_at       timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text CHECK (revoked_reason IN
                       ('replaced', 'user_disabled', 'admin_reset', 'superseded', 'enrollment_failed')),
  CONSTRAINT mfa_factors_totp_secret CHECK (
    type <> 'totp'
    OR (secret_ciphertext IS NOT NULL AND length(secret_iv) = 12 AND length(secret_tag) = 16
        AND key_id IS NOT NULL)),
  CONSTRAINT mfa_factors_status_consistency CHECK (
    (status <> 'pending' OR pending_expires_at IS NOT NULL)
    AND (status <> 'active' OR activated_at IS NOT NULL)
    AND ((status = 'revoked') = (revoked_at IS NOT NULL))
    AND ((revoked_at IS NULL) = (revoked_reason IS NULL)))
);
-- One active TOTP authenticator per user in 3A (S7-12).
CREATE UNIQUE INDEX mfa_factors_one_active_totp_idx ON mfa_factors (user_id)
  WHERE status = 'active' AND type = 'totp';
CREATE INDEX mfa_factors_user_open_idx ON mfa_factors (user_id) WHERE status <> 'revoked';
CREATE INDEX mfa_factors_key_idx ON mfa_factors (key_id) WHERE key_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- mfa_recovery_codes (S7-18)
-- ---------------------------------------------------------------------------

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  set_id     uuid NOT NULL,
  -- Public lookup id (Crockford base32): selects the one hash to verify.
  lookup_id  text NOT NULL CHECK (lookup_id ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),
  code_hash  text NOT NULL CHECK (code_hash LIKE '$argon2id$%'),
  created_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX mfa_recovery_codes_usable_lookup_idx ON mfa_recovery_codes (user_id, lookup_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- trusted_devices (S7-34, S7-35)
-- ---------------------------------------------------------------------------

CREATE TABLE trusted_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the current device token; the raw token only exists in the cookie.
  token_hash          bytea NOT NULL CHECK (length(token_hash) = 32),
  -- The token before the latest rotation: presenting it again is reuse (S7-34).
  previous_token_hash bytea CHECK (previous_token_hash IS NULL OR length(previous_token_hash) = 32),
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  last_used_at        timestamptz NOT NULL,
  ip_address          text,
  user_agent          text,
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IN ('user_revoked', 'password_reset', 'mfa_disabled',
                        'mfa_replaced', 'mfa_reset', 'reuse_detected', 'limit_exceeded')),
  CONSTRAINT trusted_devices_token_hash_key UNIQUE (token_hash),
  -- At most 30 days, never sliding (Decision 57d, S7-34).
  CONSTRAINT trusted_devices_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CONSTRAINT trusted_devices_revocation_consistency CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX trusted_devices_user_active_idx ON trusted_devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX trusted_devices_previous_hash_idx ON trusted_devices (previous_token_hash)
  WHERE previous_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- organization_security_policies (S7-29, S7-36). No row = defaults.
-- ---------------------------------------------------------------------------

CREATE TABLE organization_security_policies (
  organization_id             uuid PRIMARY KEY REFERENCES organizations (id),
  require_mfa_for_all_members boolean NOT NULL DEFAULT false,
  allow_trusted_devices       boolean NOT NULL DEFAULT true,
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id          uuid REFERENCES users (id),
  updated_at                  timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Row-level security (S7-07): user-keyed for credentials, tenant-keyed for the policy.
-- ---------------------------------------------------------------------------

ALTER TABLE mfa_factors                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_security_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY mfa_factors_own ON mfa_factors FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY mfa_recovery_codes_own ON mfa_recovery_codes FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY trusted_devices_own ON trusted_devices FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY organization_security_policies_tenant ON organization_security_policies FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON mfa_factors, mfa_recovery_codes, trusted_devices, organization_security_policies
  FROM PUBLIC;
-- No DELETE anywhere; secrets, hashes and ownership columns are not updatable by the
-- application role (only the owner-run key rotation rewrites ciphertexts, S7-09).
GRANT SELECT, INSERT ON mfa_factors TO intuit_app;
GRANT UPDATE (status, last_used_step, failed_attempts, activated_at, last_used_at, revoked_at,
              revoked_reason) ON mfa_factors TO intuit_app;
GRANT SELECT, INSERT ON mfa_recovery_codes TO intuit_app;
GRANT UPDATE (used_at, revoked_at) ON mfa_recovery_codes TO intuit_app;
GRANT SELECT, INSERT ON trusted_devices TO intuit_app;
GRANT UPDATE (token_hash, previous_token_hash, last_used_at, revoked_at, revoked_reason)
  ON trusted_devices TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON organization_security_policies TO intuit_app;

-- ---------------------------------------------------------------------------
-- Member enrollment status for administrators (S7-39): booleans only, for the members of the
-- context organization, and only when the caller is an active member of it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_member_mfa_enrollment()
  RETURNS TABLE (membership_id uuid, enrolled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT m.id,
           EXISTS (SELECT 1 FROM public.mfa_factors f
                    WHERE f.user_id = m.user_id AND f.status = 'active')
      FROM public.memberships m
     WHERE m.organization_id = public.app_current_organization_id()
       AND EXISTS (SELECT 1 FROM public.memberships me
                    WHERE me.organization_id = public.app_current_organization_id()
                      AND me.user_id = public.app_current_user_id()
                      AND me.status = 'active')
  $$;
REVOKE ALL ON FUNCTION app_member_mfa_enrollment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_member_mfa_enrollment() TO intuit_app;

-- ---------------------------------------------------------------------------
-- Admin MFA reset (Decision 72 as refined by S7-37; S7-38). The application checks
-- members.manage, re-authentication and step-up first; this function re-checks the target
-- rules authoritatively (it can see the target's other memberships, which RLS hides) and then
-- revokes factors, unused recovery codes, trusted devices and sessions in one step.
-- Refusals raise P0001 with a message 'MFA_RESET_REFUSED:<reason>'.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_reset_member_mfa(p_membership_id uuid, p_now timestamptz)
  RETURNS TABLE (target_user_id uuid, factors_revoked integer, codes_revoked integer,
                 devices_revoked integer, sessions_revoked integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_organization uuid := public.app_current_organization_id();
    v_actor        uuid := public.app_current_user_id();
    v_target       uuid;
    v_factors      integer;
    v_codes        integer;
    v_devices      integer;
    v_sessions     integer;
  BEGIN
    IF v_organization IS NULL OR v_actor IS NULL THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:context' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.memberships
                    WHERE organization_id = v_organization AND user_id = v_actor
                      AND status = 'active') THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:context' USING ERRCODE = 'P0001';
    END IF;

    SELECT m.user_id INTO v_target
      FROM public.memberships m
     WHERE m.id = p_membership_id AND m.organization_id = v_organization;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:not_found' USING ERRCODE = 'P0001';
    END IF;
    IF v_target = v_actor THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:self' USING ERRCODE = 'P0001';
    END IF;

    -- Serialize with the target's own MFA changes.
    PERFORM 1 FROM public.users WHERE id = v_target FOR UPDATE;

    -- Decision 72: never the Owner. S7-37: an Owner of any organization is refused.
    IF EXISTS (SELECT 1 FROM public.memberships m
                 JOIN public.membership_roles mr
                   ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
                WHERE m.user_id = v_target AND mr.role_is_owner) THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:owner' USING ERRCODE = 'P0001';
    END IF;
    -- S7-37: factors are account-wide, so a member of any other organization is refused.
    IF EXISTS (SELECT 1 FROM public.memberships m
                WHERE m.user_id = v_target AND m.organization_id <> v_organization) THEN
      RAISE EXCEPTION 'MFA_RESET_REFUSED:other_organization' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.mfa_factors
       SET status = 'revoked', revoked_at = p_now, revoked_reason = 'admin_reset'
     WHERE user_id = v_target AND status <> 'revoked';
    GET DIAGNOSTICS v_factors = ROW_COUNT;
    UPDATE public.mfa_recovery_codes SET revoked_at = p_now
     WHERE user_id = v_target AND used_at IS NULL AND revoked_at IS NULL;
    GET DIAGNOSTICS v_codes = ROW_COUNT;
    UPDATE public.trusted_devices SET revoked_at = p_now, revoked_reason = 'mfa_reset'
     WHERE user_id = v_target AND revoked_at IS NULL;
    GET DIAGNOSTICS v_devices = ROW_COUNT;
    UPDATE public.sessions SET revoked_at = p_now, revoked_reason = 'mfa_reset'
     WHERE user_id = v_target AND revoked_at IS NULL;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;

    RETURN QUERY SELECT v_target, v_factors, v_codes, v_devices, v_sessions;
  END;
  $$;
REVOKE ALL ON FUNCTION app_reset_member_mfa(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reset_member_mfa(uuid, timestamptz) TO intuit_app;
