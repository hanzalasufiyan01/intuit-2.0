-- 0092_expense_policies — organization-defined expense rules (master specification section 13,
-- "Expense policies"). REVERSIBLE DEFAULTS chosen by the implementer (ADR 0015); the specification
-- names policies without defining them.
--
-- Two rule types, both set by the organization (no limit or rule is built in):
--   * max_amount: an expense whose total (or, with an account, the amount posted to that expense
--     account) is above the amount breaks the rule.
--   * receipt_required_above: an expense whose total is above the amount needs at least one
--     attached file.
-- Amounts are in the organization's BASE currency. Each rule has an action: 'warn' (the person
-- posting must give a reason, which is audited) or 'block' (the expense cannot be posted). Rules
-- are archived, not deleted.

CREATE TABLE expense_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  name_key            text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  rule_type           text NOT NULL CHECK (rule_type IN ('max_amount', 'receipt_required_above')),
  amount              numeric(28, 4) NOT NULL CHECK (amount > 0),
  -- max_amount only: the expense account the limit applies to (NULL = the whole expense).
  account_id          uuid,
  action              text NOT NULL CHECK (action IN ('warn', 'block')),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT expense_policies_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT expense_policies_name_key UNIQUE (organization_id, name_key),
  CONSTRAINT expense_policies_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT expense_policies_account_rule CHECK (account_id IS NULL OR rule_type = 'max_amount')
);

-- The rule type and the account of a policy never change (archive it and add a new one).
CREATE FUNCTION expense_policy_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expense policies are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organization_id, NEW.rule_type, NEW.account_id)
     IS DISTINCT FROM (OLD.organization_id, OLD.rule_type, OLD.account_id) THEN
    RAISE EXCEPTION 'the rule type and account of an expense policy cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expense_policies_guard BEFORE UPDATE OR DELETE ON expense_policies
  FOR EACH ROW EXECUTE FUNCTION expense_policy_guard();

ALTER TABLE expense_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_policies_tenant ON expense_policies FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON expense_policies FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON expense_policies TO intuit_app;
CREATE TRIGGER expense_policies_no_truncate BEFORE TRUNCATE ON expense_policies
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
