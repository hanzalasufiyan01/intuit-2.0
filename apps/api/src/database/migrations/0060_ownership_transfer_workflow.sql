-- 0060_ownership_transfer_workflow — the controlled ownership-transfer workflow (master context
-- section 8, ADR 0001 "Ownership", ADR 0012).
--
-- The table `ownership_transfers` exists since 0001 (read-only to the application role). The
-- workflow is: the current Owner initiates (password re-authentication and MFA step-up =
-- "security verification") -> the new owner accepts (same verification) -> ownership changes in
-- one transaction -> audit and notifications. Rows are never deleted: the transfer history is
-- permanent. This migration
--   * lets the application role insert and update (never delete) transfer rows,
--   * records who cancelled and why, and who accepted,
--   * enforces the state machine in the database (forward-only; terminal states are final),
--   * keeps the timestamps consistent with the status.

GRANT INSERT, UPDATE ON ownership_transfers TO intuit_app;

ALTER TABLE ownership_transfers
  ADD COLUMN accepted_by_user_id  uuid REFERENCES users (id),
  ADD COLUMN cancelled_by_user_id uuid REFERENCES users (id),
  ADD COLUMN cancel_reason        text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  ADD COLUMN expired_at           timestamptz,
  ADD CONSTRAINT ownership_transfers_expiry_after_initiation CHECK (expires_at > initiated_at),
  ADD CONSTRAINT ownership_transfers_status_timestamps CHECK (
    (status <> 'verified' OR verified_at IS NOT NULL)
    AND (status <> 'accepted' OR (verified_at IS NOT NULL AND accepted_at IS NOT NULL))
    AND (status <> 'completed' OR (verified_at IS NOT NULL AND accepted_at IS NOT NULL AND completed_at IS NOT NULL))
    AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    AND (status <> 'expired' OR expired_at IS NOT NULL)
  );

CREATE FUNCTION app_ownership_transfer_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id
       OR NEW.from_membership_id <> OLD.from_membership_id
       OR NEW.to_membership_id <> OLD.to_membership_id
       OR NEW.replacement_role_id <> OLD.replacement_role_id
       OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
       OR NEW.initiated_at <> OLD.initiated_at
       OR NEW.expires_at <> OLD.expires_at THEN
      RAISE EXCEPTION 'An ownership transfer cannot change who is involved or when it expires'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('completed', 'cancelled', 'expired') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'A finished ownership transfer is final' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT (
      NEW.status = OLD.status
      OR (OLD.status = 'initiated' AND NEW.status IN ('verified', 'cancelled', 'expired'))
      OR (OLD.status = 'verified'  AND NEW.status IN ('accepted', 'cancelled', 'expired'))
      OR (OLD.status = 'accepted'  AND NEW.status IN ('completed', 'cancelled', 'expired'))
    ) THEN
      RAISE EXCEPTION 'Invalid ownership transfer status change % -> %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.status NOT IN ('initiated') THEN
    RAISE EXCEPTION 'An ownership transfer starts as initiated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ownership_transfers_guard BEFORE INSERT OR UPDATE ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION app_ownership_transfer_guard();
