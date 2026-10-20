-- 0066_payroll — payroll v1 (FP-25, docs/design/payroll.md): employees, pay components, pay runs
-- and payslips, posted to the general ledger through accounting events.
--
-- Scope of this version: monthly pay runs; fixed or percentage components (earnings, deductions,
-- employer contributions) with their own expense/liability accounts; proration by calendar days
-- (a setting); draft → approved → posted → paid with an optional separate-approver rule; void of
-- an unpaid run. Statutory rates are NOT built in: every contribution and deduction is a component
-- the organization configures (the Maldives rules are an open decision). Leave, advances and
-- loans are not part of v1.
--
-- Money columns are numeric(28,4). Payslips are frozen snapshots; once a run leaves DRAFT nothing
-- about it is rewritten (guard triggers). The module is switched on per organization (0065).

-- ---------------------------------------------------------------------------
-- Permissions (sensitive: owners and administrators only; no member backfill)
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('payroll.view', 'payroll', 'View employees, pay components, pay runs and payslips'),
  ('payroll.employees.manage', 'payroll', 'Create and edit employees and their pay components'),
  ('payroll.settings.manage', 'payroll', 'Manage payroll settings and pay component definitions'),
  ('payroll.runs.create', 'payroll', 'Create and recalculate draft pay runs'),
  ('payroll.runs.approve', 'payroll', 'Approve pay runs'),
  ('payroll.runs.post', 'payroll', 'Post approved pay runs to the general ledger'),
  ('payroll.runs.pay', 'payroll', 'Record the payment of posted pay runs'),
  ('payroll.runs.void', 'payroll', 'Void pay runs that are not yet paid')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE payroll_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO payroll_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('payroll.view'), ('payroll.employees.manage'), ('payroll.settings.manage'),
  ('payroll.runs.create'), ('payroll.runs.approve'), ('payroll.runs.post'),
  ('payroll.runs.pay'), ('payroll.runs.void')
) AS p (key);

CREATE TEMPORARY TABLE payroll_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN payroll_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO payroll_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0066_payroll',
       jsonb_build_object(
         'reason', 'Payroll permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM payroll_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

-- ---------------------------------------------------------------------------
-- Settings and numbering
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_settings (
  organization_id                  uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  basic_salary_expense_account_id  uuid,
  net_pay_payable_account_id       uuid,
  -- How a part-month is paid: by calendar days, or in full for any employed day.
  proration                        text NOT NULL DEFAULT 'calendar_days'
                                     CHECK (proration IN ('calendar_days', 'none')),
  -- The person who prepared a run cannot approve it (turn off for one-person organizations).
  require_separate_approver        boolean NOT NULL DEFAULT true,
  version                          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id               uuid REFERENCES users (id),
  updated_at                       timestamptz NOT NULL,
  CONSTRAINT payroll_settings_basic_fkey FOREIGN KEY (basic_salary_expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT payroll_settings_net_fkey FOREIGN KEY (net_pay_payable_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE payroll_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('employee', 'run')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

-- ---------------------------------------------------------------------------
-- Employees and pay components
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  email               text CHECK (email IS NULL OR length(email) <= 320),
  -- Sensitive: never returned in full by the API (masked to its last characters).
  national_id         text CHECK (national_id IS NULL OR length(national_id) <= 40),
  -- Optional link so the employee can read their own payslips.
  user_id             uuid REFERENCES users (id),
  hire_date           date NOT NULL,
  termination_date    date,
  basic_salary        numeric(28, 4) NOT NULL CHECK (basic_salary >= 0),
  bank_account_ref    text CHECK (bank_account_ref IS NULL OR length(bank_account_ref) <= 80),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payroll_employees_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_employees_dates CHECK (termination_date IS NULL OR termination_date >= hire_date)
);
CREATE UNIQUE INDEX payroll_employees_number_idx ON payroll_employees (organization_id, number);
CREATE UNIQUE INDEX payroll_employees_user_idx ON payroll_employees (organization_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE payroll_components (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind                text NOT NULL CHECK (kind IN ('earning', 'deduction', 'employer_contribution')),
  calculation         text NOT NULL CHECK (calculation IN ('fixed', 'percent_of_basic', 'percent_of_gross')),
  default_value       numeric(28, 6) NOT NULL DEFAULT 0 CHECK (default_value >= 0),
  expense_account_id  uuid,
  liability_account_id uuid,
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payroll_components_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_components_expense_fkey FOREIGN KEY (expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT payroll_components_liability_fkey FOREIGN KEY (liability_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  -- Earnings expense; deductions owe; employer contributions do both.
  CONSTRAINT payroll_components_accounts CHECK (
    (kind = 'earning' AND expense_account_id IS NOT NULL AND liability_account_id IS NULL)
    OR (kind = 'deduction' AND liability_account_id IS NOT NULL AND expense_account_id IS NULL)
    OR (kind = 'employer_contribution' AND expense_account_id IS NOT NULL AND liability_account_id IS NOT NULL)),
  -- Earnings are never a share of gross (that would be circular).
  CONSTRAINT payroll_components_earning_base CHECK (kind <> 'earning' OR calculation <> 'percent_of_gross'),
  CONSTRAINT payroll_components_percent_range CHECK (calculation = 'fixed' OR default_value <= 100)
);
CREATE UNIQUE INDEX payroll_components_code_idx ON payroll_components (organization_id, code);

CREATE TABLE payroll_employee_components (
  organization_id  uuid NOT NULL,
  employee_id      uuid NOT NULL,
  component_id     uuid NOT NULL,
  -- NULL uses the component's default value.
  value            numeric(28, 6) CHECK (value IS NULL OR value >= 0),
  PRIMARY KEY (employee_id, component_id),
  CONSTRAINT payroll_employee_components_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id),
  CONSTRAINT payroll_employee_components_component_fkey FOREIGN KEY (component_id, organization_id)
    REFERENCES payroll_components (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Pay runs and payslips
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations (id),
  number                 text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  pay_date               date NOT NULL,
  status                 text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'PAID', 'VOID')),
  employee_count         integer NOT NULL CHECK (employee_count >= 0),
  gross_total            numeric(28, 4) NOT NULL CHECK (gross_total >= 0),
  deductions_total       numeric(28, 4) NOT NULL CHECK (deductions_total >= 0),
  net_total              numeric(28, 4) NOT NULL CHECK (net_total >= 0),
  employer_cost_total    numeric(28, 4) NOT NULL CHECK (employer_cost_total >= 0),
  approved_by_user_id    uuid REFERENCES users (id),
  approved_at            timestamptz,
  journal_id             uuid,
  accounting_event_id    uuid,
  posted_by_user_id      uuid REFERENCES users (id),
  posted_at              timestamptz,
  payment_account_id     uuid,
  payment_date           date,
  payment_journal_id     uuid,
  payment_event_id       uuid,
  paid_by_user_id        uuid REFERENCES users (id),
  paid_at                timestamptz,
  voided_by_user_id      uuid REFERENCES users (id),
  voided_at              timestamptz,
  void_reason            text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  void_journal_id        uuid,
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id     uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  updated_by_user_id     uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  CONSTRAINT payroll_runs_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_runs_period CHECK (period_start <= period_end),
  CONSTRAINT payroll_runs_net CHECK (net_total = gross_total - deductions_total),
  CONSTRAINT payroll_runs_void_consistency CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL) AND (status <> 'VOID' OR void_reason IS NOT NULL)),
  CONSTRAINT payroll_runs_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT payroll_runs_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT payroll_runs_payment_account_fkey FOREIGN KEY (payment_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT payroll_runs_payment_journal_fkey FOREIGN KEY (payment_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT payroll_runs_payment_event_fkey FOREIGN KEY (payment_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT payroll_runs_void_journal_fkey FOREIGN KEY (void_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id)
);
CREATE UNIQUE INDEX payroll_runs_number_idx ON payroll_runs (organization_id, number);
-- One live run per exact period: paying the same period twice is refused by the database.
CREATE UNIQUE INDEX payroll_runs_period_idx ON payroll_runs (organization_id, period_start, period_end)
  WHERE status <> 'VOID';
CREATE INDEX payroll_runs_list_idx ON payroll_runs (organization_id, period_end DESC, id);

CREATE TABLE payroll_payslips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  run_id              uuid NOT NULL,
  employee_id         uuid NOT NULL,
  employee_number     text NOT NULL,
  employee_name       text NOT NULL,
  employee_user_id    uuid,
  basic_salary        numeric(28, 4) NOT NULL CHECK (basic_salary >= 0),
  proration_factor    numeric(12, 8) NOT NULL CHECK (proration_factor > 0 AND proration_factor <= 1),
  gross               numeric(28, 4) NOT NULL CHECK (gross >= 0),
  deductions          numeric(28, 4) NOT NULL CHECK (deductions >= 0),
  net                 numeric(28, 4) NOT NULL CHECK (net >= 0),
  employer_cost       numeric(28, 4) NOT NULL CHECK (employer_cost >= 0),
  CONSTRAINT payroll_payslips_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_payslips_run_fkey FOREIGN KEY (run_id, organization_id)
    REFERENCES payroll_runs (id, organization_id),
  CONSTRAINT payroll_payslips_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id),
  CONSTRAINT payroll_payslips_net CHECK (net = gross - deductions),
  CONSTRAINT payroll_payslips_once UNIQUE (run_id, employee_id)
);
CREATE INDEX payroll_payslips_user_idx ON payroll_payslips (organization_id, employee_user_id)
  WHERE employee_user_id IS NOT NULL;

CREATE TABLE payroll_payslip_lines (
  organization_id       uuid NOT NULL,
  payslip_id            uuid NOT NULL,
  line_no               integer NOT NULL CHECK (line_no >= 1),
  component_id          uuid,
  code                  text NOT NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('basic', 'earning', 'deduction', 'employer_contribution')),
  amount                numeric(28, 4) NOT NULL CHECK (amount > 0),
  expense_account_id    uuid,
  liability_account_id  uuid,
  PRIMARY KEY (payslip_id, line_no),
  CONSTRAINT payroll_payslip_lines_payslip_fkey FOREIGN KEY (payslip_id, organization_id)
    REFERENCES payroll_payslips (id, organization_id),
  CONSTRAINT payroll_payslip_lines_expense_fkey FOREIGN KEY (expense_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT payroll_payslip_lines_liability_fkey FOREIGN KEY (liability_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- A run is rewritten only while DRAFT; afterwards only its workflow fields change, and only
-- forward. A void run and a paid run are final. Runs are never deleted.
CREATE FUNCTION payroll_guard_run() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay runs are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('VOID', 'PAID') THEN
    RAISE EXCEPTION '% pay run % is immutable', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'APPROVED', 'VOID'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'POSTED', 'VOID'))
    OR (OLD.status = 'POSTED' AND NEW.status IN ('POSTED', 'PAID', 'VOID'))
  ) THEN
    RAISE EXCEPTION 'pay run % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.number, NEW.period_start, NEW.period_end, NEW.pay_date, NEW.employee_count,
       NEW.gross_total, NEW.deductions_total, NEW.net_total, NEW.employer_cost_total,
       NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM (
       OLD.number, OLD.period_start, OLD.period_end, OLD.pay_date, OLD.employee_count,
       OLD.gross_total, OLD.deductions_total, OLD.net_total, OLD.employer_cost_total,
       OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the figures of pay run % are frozen once it leaves draft', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_run();

-- Payslips and their lines are never updated and are removed only with a DRAFT run (recalculation).
CREATE FUNCTION payroll_guard_payslip() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
  run_ref uuid;
BEGIN
  IF TG_TABLE_NAME = 'payroll_payslips' THEN
    run_ref := OLD.run_id;
  ELSE
    SELECT run_id INTO run_ref FROM payroll_payslips
     WHERE id = OLD.payslip_id AND organization_id = OLD.organization_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payslips are never updated' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO run_status FROM payroll_runs
   WHERE id = run_ref AND organization_id = OLD.organization_id;
  IF run_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'payslips of a pay run that is not a draft cannot be removed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER payroll_payslips_guard BEFORE UPDATE OR DELETE ON payroll_payslips
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_payslip();
CREATE TRIGGER payroll_payslip_lines_guard BEFORE UPDATE OR DELETE ON payroll_payslip_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_payslip();

-- ---------------------------------------------------------------------------
-- Row-level security, grants, no-truncate
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_settings', 'payroll_number_sequences', 'payroll_employees', 'payroll_components',
    'payroll_employee_components', 'payroll_runs', 'payroll_payslips', 'payroll_payslip_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON payroll_settings, payroll_number_sequences, payroll_employees,
  payroll_components, payroll_runs TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_employee_components TO intuit_app;
GRANT SELECT, INSERT, DELETE ON payroll_payslips, payroll_payslip_lines TO intuit_app;
