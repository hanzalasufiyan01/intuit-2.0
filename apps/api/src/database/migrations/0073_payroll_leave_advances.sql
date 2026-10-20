-- 0073_payroll_leave_advances — leave and salary advances for payroll (FP-25 follow-up,
-- docs/design/payroll.md).
--
-- Leave: types with an annual entitlement, requests by or for an employee, approval, and a balance
-- per year. Days are entered explicitly (half days allowed): which days count as working days is an
-- open policy decision, so nothing derives them. Leave is a record; it does not change a payslip.
--
-- Advances: money paid out to an employee (Dr the advances asset account / Cr bank, posted when
-- the advance is granted) and recovered by a fixed instalment that the pay run deducts as a payslip
-- line crediting the same asset account. The outstanding balance is the principal less the
-- repayments of runs that are posted or paid, so voiding a run gives the instalment back without
-- editing anything.

INSERT INTO permissions (key, module, description) VALUES
  ('payroll.leave.manage', 'payroll', 'Manage leave types and approve or reject leave requests'),
  ('payroll.advances.manage', 'payroll', 'Grant, view and cancel salary advances')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE payroll2_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO payroll2_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES ('payroll.leave.manage'), ('payroll.advances.manage')) AS p (key);

CREATE TEMPORARY TABLE payroll2_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN payroll2_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO payroll2_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0073_payroll_leave_advances',
       jsonb_build_object(
         'reason', 'Payroll leave and advances permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM payroll2_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

ALTER TABLE payroll_settings ADD COLUMN advances_account_id uuid;
ALTER TABLE payroll_settings ADD CONSTRAINT payroll_settings_advances_fkey
  FOREIGN KEY (advances_account_id, organization_id) REFERENCES accounting_accounts (id, organization_id);

ALTER TABLE payroll_number_sequences DROP CONSTRAINT payroll_number_sequences_document_type_check;
ALTER TABLE payroll_number_sequences ADD CONSTRAINT payroll_number_sequences_document_type_check
  CHECK (document_type IN ('employee', 'run', 'advance'));

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_leave_types (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  days_per_year       numeric(8, 2) NOT NULL CHECK (days_per_year >= 0 AND days_per_year <= 366),
  -- Whether a request may take the balance below zero.
  allow_negative      boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payroll_leave_types_id_organization_key UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX payroll_leave_types_code_idx ON payroll_leave_types (organization_id, code);

CREATE TABLE payroll_leave_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  employee_id         uuid NOT NULL,
  leave_type_id       uuid NOT NULL,
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  -- Entered by the requester (half days allowed); at most the calendar days of the span.
  days                numeric(8, 2) NOT NULL CHECK (days > 0),
  reason              text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  status              text NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by_user_id  uuid REFERENCES users (id),
  decided_at          timestamptz,
  decision_note       text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  requested_by_user_id uuid NOT NULL REFERENCES users (id),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payroll_leave_requests_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_leave_requests_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id),
  CONSTRAINT payroll_leave_requests_type_fkey FOREIGN KEY (leave_type_id, organization_id)
    REFERENCES payroll_leave_types (id, organization_id),
  CONSTRAINT payroll_leave_requests_dates CHECK (end_date >= start_date),
  CONSTRAINT payroll_leave_requests_span CHECK (days <= (end_date - start_date) + 1),
  CONSTRAINT payroll_leave_requests_decided CHECK (
    (status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL))
);
CREATE INDEX payroll_leave_requests_employee_idx
  ON payroll_leave_requests (organization_id, employee_id, start_date);

-- A request moves forward only; its content is fixed once it leaves PENDING.
CREATE FUNCTION payroll_guard_leave_request() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'leave requests are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION '% leave request % is final', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'leave request % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'PENDING' AND (
       NEW.employee_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, NEW.days)
     IS DISTINCT FROM (OLD.employee_id, OLD.leave_type_id, OLD.start_date, OLD.end_date, OLD.days) THEN
    RAISE EXCEPTION 'the content of leave request % is fixed once decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_leave_requests_guard BEFORE UPDATE OR DELETE ON payroll_leave_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_leave_request();

-- ---------------------------------------------------------------------------
-- Salary advances
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_advances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  employee_id         uuid NOT NULL,
  granted_date        date NOT NULL,
  principal           numeric(28, 4) NOT NULL CHECK (principal > 0),
  installment         numeric(28, 4) NOT NULL CHECK (installment > 0 AND installment <= principal),
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  bank_account_id     uuid NOT NULL,
  journal_id          uuid NOT NULL,
  accounting_event_id uuid NOT NULL,
  cancel_reason       text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  cancel_journal_id   uuid,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payroll_advances_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT payroll_advances_employee_fkey FOREIGN KEY (employee_id, organization_id)
    REFERENCES payroll_employees (id, organization_id),
  CONSTRAINT payroll_advances_bank_fkey FOREIGN KEY (bank_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id),
  CONSTRAINT payroll_advances_journal_fkey FOREIGN KEY (journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT payroll_advances_event_fkey FOREIGN KEY (accounting_event_id, organization_id)
    REFERENCES accounting_events (id, organization_id),
  CONSTRAINT payroll_advances_cancel_journal_fkey FOREIGN KEY (cancel_journal_id, organization_id)
    REFERENCES accounting_journal_entries (id, organization_id),
  CONSTRAINT payroll_advances_cancel CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX payroll_advances_number_idx ON payroll_advances (organization_id, number);
CREATE INDEX payroll_advances_employee_idx ON payroll_advances (organization_id, employee_id, granted_date);

CREATE TABLE payroll_advance_repayments (
  organization_id  uuid NOT NULL,
  advance_id       uuid NOT NULL,
  run_id           uuid NOT NULL,
  payslip_id       uuid NOT NULL,
  amount           numeric(28, 4) NOT NULL CHECK (amount > 0),
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (advance_id, run_id),
  CONSTRAINT payroll_advance_repayments_advance_fkey FOREIGN KEY (advance_id, organization_id)
    REFERENCES payroll_advances (id, organization_id),
  CONSTRAINT payroll_advance_repayments_run_fkey FOREIGN KEY (run_id, organization_id)
    REFERENCES payroll_runs (id, organization_id),
  CONSTRAINT payroll_advance_repayments_payslip_fkey FOREIGN KEY (payslip_id, organization_id)
    REFERENCES payroll_payslips (id, organization_id)
);
CREATE TRIGGER payroll_advance_repayments_immutable BEFORE UPDATE OR DELETE ON payroll_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();

-- An advance is never edited apart from its cancellation, and never deleted.
CREATE FUNCTION payroll_guard_advance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'advances are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cancelled advance % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.employee_id, NEW.granted_date, NEW.principal, NEW.installment, NEW.bank_account_id,
      NEW.journal_id, NEW.number)
     IS DISTINCT FROM (OLD.employee_id, OLD.granted_date, OLD.principal, OLD.installment,
      OLD.bank_account_id, OLD.journal_id, OLD.number) THEN
    RAISE EXCEPTION 'the figures of advance % are fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_advances_guard BEFORE UPDATE OR DELETE ON payroll_advances
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_advance();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_leave_types', 'payroll_leave_requests', 'payroll_advances', 'payroll_advance_repayments'
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

GRANT SELECT, INSERT, UPDATE ON payroll_leave_types, payroll_leave_requests, payroll_advances TO intuit_app;
GRANT SELECT, INSERT ON payroll_advance_repayments TO intuit_app;
