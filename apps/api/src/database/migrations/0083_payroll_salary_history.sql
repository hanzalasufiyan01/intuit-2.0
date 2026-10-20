-- 0083_payroll_salary_history — effective-dated basic salary and payslip availability notices
-- (FP-25).
--
-- * payroll_salary_history is append-only: one row per salary decision with the date it takes effect.
--   The salary on a date is the row with the latest effective date on or before it (a correction is a
--   newer row for the same date). payroll_employees.basic_salary stays as the MOST RECENT salary so the
--   existing screens keep working; every existing employee gets a first row from the hire date.
-- * A pay run uses the history: with day-proration a mid-period change is split by days; a payslip
--   keeps the segments it used (salary_segments) so the figure can be explained later.
-- * payroll_payslip_notifications records the "your payslip is available" e-mails (no figures in
--   them). One SENT notice per payslip; a failed attempt can be retried.

CREATE TABLE payroll_salary_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  employee_id         uuid NOT NULL,
  effective_from      date NOT NULL,
  basic_salary        numeric(28, 4) NOT NULL CHECK (basic_salary >= 0),
  reason              text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT payroll_salary_history_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id)
);
CREATE INDEX payroll_salary_history_employee_idx
  ON payroll_salary_history (organization_id, employee_id, effective_from DESC, created_at DESC);
CREATE TRIGGER payroll_salary_history_immutable BEFORE UPDATE OR DELETE ON payroll_salary_history
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

INSERT INTO payroll_salary_history (organization_id, employee_id, effective_from, basic_salary, reason, created_at)
SELECT organization_id, id, hire_date, basic_salary, 'Opening salary (migration)', now()
  FROM payroll_employees;

ALTER TABLE payroll_payslips ADD COLUMN salary_segments jsonb;

CREATE TABLE payroll_payslip_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  payslip_id          uuid NOT NULL,
  employee_id         uuid NOT NULL,
  status              text NOT NULL CHECK (status IN ('SENT', 'FAILED')),
  error               text CHECK (error IS NULL OR length(error) <= 300),
  sent_by_user_id     uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT payroll_payslip_notifications_payslip_fkey FOREIGN KEY (payslip_id, organization_id)
    REFERENCES payroll_payslips (id, organization_id),
  CONSTRAINT payroll_payslip_notifications_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id)
);
CREATE UNIQUE INDEX payroll_payslip_notifications_sent_idx ON payroll_payslip_notifications (payslip_id)
  WHERE status = 'SENT';
CREATE INDEX payroll_payslip_notifications_list_idx ON payroll_payslip_notifications (organization_id, payslip_id, created_at);
CREATE TRIGGER payroll_payslip_notifications_immutable BEFORE UPDATE OR DELETE ON payroll_payslip_notifications
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_salary_history', 'payroll_payslip_notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO intuit_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
