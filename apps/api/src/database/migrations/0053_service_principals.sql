-- 0053_service_principals — non-human service principals (ADR 0011, D2; Step 1).
--
-- * `users.kind` is 'human' (every existing row) or 'service'. A service principal is an
--   organization-owned, non-interactive identity for future API integrations. It exists in `users`
--   only so that the existing `*_by_user_id` foreign keys, memberships and RLS keep working.
-- * Human invariants are not weakened: email, email_normalized and the Argon2id password hash are
--   made nullable at the storage level ONLY together with a CHECK that requires all three for a
--   human and forbids all three for a service principal. All existing format checks still apply.
-- * `kind` never changes after insert.
-- * A service principal can never log in, hold a session, reset a password, enroll MFA, hold a
--   role (so never Owner), be an approver, accept or send an invitation, create an organization,
--   take part in an ownership transfer, or belong to more than one organization. These are
--   database guards; the application also filters service principals out of member flows.

ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'human'
  CONSTRAINT users_kind_check CHECK (kind IN ('human', 'service'));
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email_normalized DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_kind_identity CHECK (
  (kind = 'human'
     AND email IS NOT NULL AND email_normalized IS NOT NULL AND password_hash IS NOT NULL)
  OR
  (kind = 'service'
     AND email IS NULL AND email_normalized IS NULL AND password_hash IS NULL
     AND email_verified_at IS NULL));

CREATE FUNCTION users_guard_kind() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'the kind of user % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_kind_immutable BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_kind();

-- Rejects a row that names a service principal in the column given as argument.
CREATE FUNCTION app_reject_service_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_user uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF v_user IS NOT NULL AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user AND u.kind = 'service') THEN
    RAISE EXCEPTION '% on % must be a human user, not a service principal', TG_ARGV[0], TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Rejects a row that names the membership of a service principal in the column given as argument.
CREATE FUNCTION app_reject_service_membership() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_membership uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF v_membership IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
        WHERE m.id = v_membership AND u.kind = 'service') THEN
    RAISE EXCEPTION '% on % cannot be the membership of a service principal', TG_ARGV[0], TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- No interactive credentials or sessions.
CREATE TRIGGER sessions_human_only BEFORE INSERT OR UPDATE OF user_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('user_id');
CREATE TRIGGER password_reset_tokens_human_only BEFORE INSERT OR UPDATE OF user_id ON password_reset_tokens
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('user_id');
CREATE TRIGGER mfa_factors_human_only BEFORE INSERT OR UPDATE OF user_id ON mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('user_id');
CREATE TRIGGER mfa_recovery_codes_human_only BEFORE INSERT OR UPDATE OF user_id ON mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('user_id');
CREATE TRIGGER trusted_devices_human_only BEFORE INSERT OR UPDATE OF user_id ON trusted_devices
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('user_id');

-- No invitation, organization-creation or ownership flows.
CREATE TRIGGER invitations_inviter_human_only BEFORE INSERT OR UPDATE OF invited_by_user_id ON invitations
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('invited_by_user_id');
CREATE TRIGGER invitations_acceptor_human_only BEFORE INSERT OR UPDATE OF accepted_by_user_id ON invitations
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('accepted_by_user_id');
CREATE TRIGGER organizations_creator_human_only BEFORE INSERT OR UPDATE OF created_by_user_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('created_by_user_id');
CREATE TRIGGER ownership_transfers_initiator_human_only BEFORE INSERT OR UPDATE OF initiated_by_user_id ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('initiated_by_user_id');
CREATE TRIGGER ownership_transfers_from_human_only BEFORE INSERT OR UPDATE OF from_membership_id ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_membership('from_membership_id');
CREATE TRIGGER ownership_transfers_to_human_only BEFORE INSERT OR UPDATE OF to_membership_id ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_membership('to_membership_id');

-- No roles (so never Owner, never a role-based approver) and no explicit approver status.
CREATE TRIGGER membership_roles_human_only BEFORE INSERT OR UPDATE OF membership_id ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_membership('membership_id');
CREATE TRIGGER approval_step_eligible_members_human_only
  BEFORE INSERT OR UPDATE OF membership_id ON approval_step_eligible_members
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_membership('membership_id');
CREATE TRIGGER approval_decisions_human_only
  BEFORE INSERT OR UPDATE OF approver_membership_id ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_membership('approver_membership_id');
CREATE TRIGGER approval_decisions_approver_user_human_only
  BEFORE INSERT OR UPDATE OF approver_user_id ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app_reject_service_user('approver_user_id');

-- A service principal belongs to exactly one organization: one membership, never moved.
CREATE FUNCTION memberships_guard_service() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.kind = 'service') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.organization_id) IS DISTINCT FROM (OLD.user_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'a service principal membership cannot move' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = NEW.user_id AND m.id <> NEW.id) THEN
    RAISE EXCEPTION 'a service principal belongs to exactly one organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memberships_service_guard BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_guard_service();

REVOKE ALL ON FUNCTION app_reject_service_user(), app_reject_service_membership(),
  memberships_guard_service(), users_guard_kind() FROM PUBLIC;
