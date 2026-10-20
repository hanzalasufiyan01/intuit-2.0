-- 0089_payroll_run_adjustments — one-off pay-run amounts: bonuses, commissions, overtime pay
-- entered by payroll staff (master specification section 17: "Overtime, Bonuses, Commissions").
--
-- An adjustment is an AMOUNT that payroll staff enter for one employee in one DRAFT pay run, using
-- an existing pay component (earning or deduction) of the fixed-amount kind. The system calculates
-- no overtime hours, no commission and no statutory rule: how much is due is the organization's
-- decision. Adjustments exist only while the run is a draft; recalculation turns them into payslip
-- lines, and the payslips (frozen once the run leaves draft) remain the record.

CREATE TABLE payroll_run_adjustments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  run_id              uuid NOT NULL,
  employee_id         uuid NOT NULL,
  component_id        uuid NOT NULL,
  amount              numeric(28, 4) NOT NULL CHECK (amount > 0),
  -- A short label such as "Q1 sales commission"; never personal details.
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT payroll_run_adjustments_run_fkey FOREIGN KEY (run_id, organization_id)
    REFERENCES payroll_runs (id, organization_id),
  CONSTRAINT payroll_run_adjustments_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id),
  CONSTRAINT payroll_run_adjustments_component_fkey FOREIGN KEY (component_id, organization_id)
    REFERENCES payroll_components (id, organization_id)
);
CREATE INDEX payroll_run_adjustments_run_idx ON payroll_run_adjustments (organization_id, run_id);

-- Adjustments can only be added or removed while the run is a draft.
CREATE FUNCTION payroll_adjustment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s text;
  r uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  o uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payroll adjustments are replaced, not edited' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO s FROM payroll_runs WHERE id = r AND organization_id = o;
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'adjustments can only change while the pay run is a draft'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER payroll_run_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_adjustments
  FOR EACH ROW EXECUTE FUNCTION payroll_adjustment_guard();

ALTER TABLE payroll_run_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_run_adjustments_tenant ON payroll_run_adjustments FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON payroll_run_adjustments FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON payroll_run_adjustments TO intuit_app;
CREATE TRIGGER payroll_run_adjustments_no_truncate BEFORE TRUNCATE ON payroll_run_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
