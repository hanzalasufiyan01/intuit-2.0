-- 0054_audit_api_token_actor — `api_token` audit actor (ADR 0011, D2 and section 19.5; Step 1).
--
-- * Public API activity is recorded as actor_type 'api_token'. The actor is the organization-owned
--   service principal (actor_user_id, a users row of kind 'service') plus the integration it belongs
--   to (actor_integration_id) and optionally the token used (actor_token_id). The integration and
--   token tables arrive in a later step, so these two columns are plain identifiers here and never
--   carry a foreign key (audit history must outlive any revoked integration or token).
-- * 'user', 'system' and 'anonymous' keep their meaning: 'user' is a human user, 'system' and
--   'anonymous' name no user. Existing rows are unaffected.
-- * recordAuditEvent derives the actor from the identity. The trigger below only VERIFIES the
--   attribution (a service principal can never be recorded as a user, nor a human as an api_token)
--   and never rewrites a row.

ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_consistency;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events ADD COLUMN actor_integration_id uuid;
ALTER TABLE audit_events ADD COLUMN actor_token_id uuid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'anonymous', 'api_token'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_consistency CHECK (
  (actor_type = 'user'
     AND actor_user_id IS NOT NULL AND actor_integration_id IS NULL AND actor_token_id IS NULL)
  OR (actor_type = 'api_token'
     AND actor_user_id IS NOT NULL AND actor_integration_id IS NOT NULL)
  OR (actor_type IN ('system', 'anonymous')
     AND actor_user_id IS NULL AND actor_integration_id IS NULL AND actor_token_id IS NULL));

CREATE FUNCTION audit_events_verify_actor() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.actor_user_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u.kind INTO v_kind FROM public.users u WHERE u.id = NEW.actor_user_id;
  IF NEW.actor_type = 'user' AND v_kind IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'a service principal cannot be recorded as a user actor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.actor_type = 'api_token' AND v_kind IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'an api_token actor must be a service principal'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_events_verify_actor BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_verify_actor();
REVOKE ALL ON FUNCTION audit_events_verify_actor() FROM PUBLIC;
