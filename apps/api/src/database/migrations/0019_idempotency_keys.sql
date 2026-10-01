-- 0019_idempotency_keys — Phase 3B step 1: the reusable request-idempotency store (Decision 23).
--
-- A client sends an `Idempotency-Key` with a request. The operation claims the key by inserting its
-- row first, in the operation's own transaction, and stores the response before committing. A
-- concurrent duplicate waits on the unique index; once the first transaction commits it finds the
-- completed row and replays the stored response. If the operation fails, the claim rolls back with
-- it, so failures are never cached. A key reused with a different request, or by another user, is
-- refused. Duplicate *detection* (for example a warning about a similar invoice) is separate.
--
-- Rows are immutable once completed and expire after a retention window; only expired rows can be
-- deleted, by a narrow SECURITY DEFINER housekeeping function.

CREATE TABLE idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  scope            text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(scope) <= 100),
  idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response         jsonb,
  created_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_key UNIQUE (organization_id, scope, idempotency_key),
  CONSTRAINT idempotency_keys_completion CHECK ((response IS NULL) = (completed_at IS NULL)),
  CONSTRAINT idempotency_keys_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

-- A claim is completed exactly once; nothing else ever changes.
CREATE FUNCTION idempotency_guard_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > now() THEN
      RAISE EXCEPTION 'idempotency key % has not expired', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.user_id, NEW.scope, NEW.idempotency_key, NEW.request_hash,
      NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.user_id, OLD.scope, OLD.idempotency_key, OLD.request_hash,
      OLD.created_at, OLD.expires_at)
     OR OLD.response IS NOT NULL THEN
    RAISE EXCEPTION 'idempotency key % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_guard
  BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION idempotency_guard_key();
CREATE TRIGGER idempotency_keys_no_truncate
  BEFORE TRUNCATE ON idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant ON idempotency_keys FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON idempotency_keys FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO intuit_app;

-- Housekeeping across organizations: removes expired keys only; returns how many.
CREATE FUNCTION app_purge_expired_idempotency_keys(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM idempotency_keys
   WHERE id IN (SELECT id FROM idempotency_keys WHERE expires_at <= now()
                 ORDER BY expires_at LIMIT greatest(1, least(p_limit, 10000)));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION app_purge_expired_idempotency_keys(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_expired_idempotency_keys(integer) TO intuit_app;
