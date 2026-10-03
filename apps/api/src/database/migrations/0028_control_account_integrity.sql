-- 0028_control_account_integrity — Phase 4A-1 guard (ADR 0004, P4-08 amendment "control-account
-- integrity", approved 2026-10-01).
--
-- While an account is owned by a subledger (control_subledger IS NOT NULL) it cannot be
-- reclassified (type or subtype), change currency, change its parent, gain a child account, or be
-- archived. The owning subledger's settings workflow releases ownership first; a released account
-- can then be changed normally. The application refuses these changes with a clear message
-- before they reach the database; these triggers are the database-level backstop.

CREATE FUNCTION accounting_guard_control_account() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_type, NEW.subtype, NEW.currency_code, NEW.parent_id, NEW.status)
     IS DISTINCT FROM
     (OLD.account_type, OLD.subtype, OLD.currency_code, OLD.parent_id, OLD.status) THEN
    RAISE EXCEPTION 'account % is the control account of the % subledger; release it in that module''s settings before changing its classification, currency, parent or status',
      OLD.id, OLD.control_subledger
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_accounts_control_integrity
  BEFORE UPDATE OF account_type, subtype, currency_code, parent_id, status ON accounting_accounts
  FOR EACH ROW WHEN (OLD.control_subledger IS NOT NULL)
  EXECUTE FUNCTION accounting_guard_control_account();

-- A control account stays a posting (leaf) account: no account is created under it or moved
-- under it while it is owned.
CREATE FUNCTION accounting_guard_control_parent() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id)
     AND EXISTS (
       SELECT 1 FROM accounting_accounts p
        WHERE p.id = NEW.parent_id
          AND p.organization_id = NEW.organization_id
          AND p.control_subledger IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'account % is a subledger control account and cannot have child accounts', NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_accounts_control_parent
  BEFORE INSERT OR UPDATE OF parent_id ON accounting_accounts
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_control_parent();
