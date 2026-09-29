-- 0018_approval_conditions — Phase 3A S10: conditional approvals.
-- Decisions 22, 56, 77; S10-01 to S10-12 (ADR 0003).
--
-- * Approval policy steps gain optional conditions: a base-currency amount band
--   (min_base_amount inclusive, max_base_amount exclusive, in threshold_currency) and a list of
--   transaction types. A step with no condition always applies. Existing steps stay unconditional.
-- * Approval requests become immutable once created, apart from their single resolution
--   (pending -> approved | rejected | withdrawn), so the snapshot of matching steps and the
--   evaluated facts can never be altered.

ALTER TABLE approval_policy_steps
  ADD COLUMN min_base_amount    numeric(28, 4) CHECK (min_base_amount >= 0),
  ADD COLUMN max_base_amount    numeric(28, 4) CHECK (max_base_amount > 0),
  ADD COLUMN transaction_types  text[],
  ADD COLUMN threshold_currency char(3) REFERENCES accounting_currencies (code);

ALTER TABLE approval_policy_steps
  ADD CONSTRAINT approval_policy_steps_amount_band
    CHECK (min_base_amount IS NULL OR max_base_amount IS NULL OR max_base_amount > min_base_amount),
  ADD CONSTRAINT approval_policy_steps_threshold_currency
    CHECK ((threshold_currency IS NOT NULL) = (min_base_amount IS NOT NULL OR max_base_amount IS NOT NULL)),
  ADD CONSTRAINT approval_policy_steps_transaction_types
    CHECK (transaction_types IS NULL OR (
      cardinality(transaction_types) BETWEEN 1 AND 20
      AND array_position(transaction_types, NULL) IS NULL
      AND array_to_string(transaction_types, ',') ~ '^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$'));

-- ---------------------------------------------------------------------------
-- Approval requests: immutable apart from their one resolution
-- ---------------------------------------------------------------------------

CREATE FUNCTION approval_guard_request() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval requests are append-only: DELETE is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.action_key, NEW.subject_type, NEW.subject_id,
      NEW.policy_snapshot, NEW.requested_by_user_id, NEW.excluded_user_ids, NEW.reason,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.action_key, OLD.subject_type, OLD.subject_id,
      OLD.policy_snapshot, OLD.requested_by_user_id, OLD.excluded_user_ids, OLD.reason,
      OLD.created_at) THEN
    RAISE EXCEPTION 'approval request % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'withdrawn')) THEN
    RAISE EXCEPTION 'approval request % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'approval request % is already resolved', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_guard_request();
CREATE TRIGGER approval_requests_no_truncate
  BEFORE TRUNCATE ON approval_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
