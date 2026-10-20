-- 0067_projects — projects, time tracking and billing of approved time (FP-26,
-- docs/design/projects-job-costing.md).
--
-- A project is a cost object: it owns one value of the system dimension type PROJECT, so every
-- invoice, bill, expense and journal line tagged with it is that project's revenue or cost and the
-- existing dimension-filtered reports are the project's profit and loss (it cannot disagree with the
-- books). Time is logged by project members, submitted, approved by a manager, and billed once into
-- a draft sales invoice (a unique link makes double billing impossible). Rates are frozen on each
-- entry when it is logged. The module is switched on per organization (0065).

INSERT INTO permissions (key, module, description) VALUES
  ('projects.view', 'projects', 'View projects, time entries and project reports'),
  ('projects.manage', 'projects', 'Create and edit projects and their members'),
  ('projects.time.log', 'projects', 'Log and submit your own time on projects you belong to'),
  ('projects.time.approve', 'projects', 'Approve or reject submitted time'),
  ('projects.bill', 'projects', 'Create draft invoices from approved billable time')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE projects_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO projects_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('projects.view'), ('projects.manage'), ('projects.time.log'), ('projects.time.approve'),
  ('projects.bill')
) AS p (key);

CREATE TEMPORARY TABLE projects_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN projects_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO projects_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0067_projects',
       jsonb_build_object(
         'reason', 'Projects permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM projects_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

CREATE TABLE project_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('project')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number                text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  customer_id           uuid,
  status                text NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  billing_method        text NOT NULL DEFAULT 'time_and_materials'
                          CHECK (billing_method IN ('fixed', 'time_and_materials', 'non_billable')),
  start_date            date,
  end_date              date,
  budget_amount         numeric(28, 4) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  budget_hours          numeric(12, 2) CHECK (budget_hours IS NULL OR budget_hours >= 0),
  default_bill_rate     numeric(28, 4) NOT NULL DEFAULT 0 CHECK (default_bill_rate >= 0),
  -- The PROJECT dimension value that carries this project's revenue and cost.
  dimension_value_id    uuid NOT NULL,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT projects_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT projects_customer_fkey FOREIGN KEY (customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT projects_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX projects_number_idx ON projects (organization_id, number);
CREATE UNIQUE INDEX projects_dimension_idx ON projects (organization_id, dimension_value_id);
CREATE INDEX projects_list_idx ON projects (organization_id, status, id);

CREATE TABLE project_members (
  organization_id  uuid NOT NULL,
  project_id       uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users (id),
  -- NULL: the project's default bill rate. The cost rate is what the hour costs the business.
  bill_rate        numeric(28, 4) CHECK (bill_rate IS NULL OR bill_rate >= 0),
  cost_rate        numeric(28, 4) NOT NULL DEFAULT 0 CHECK (cost_rate >= 0),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_project_fkey FOREIGN KEY (project_id, organization_id)
    REFERENCES projects (id, organization_id)
);

CREATE TABLE project_time_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  project_id            uuid NOT NULL,
  user_id               uuid NOT NULL REFERENCES users (id),
  work_date             date NOT NULL,
  hours                 numeric(6, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description           text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  billable              boolean NOT NULL,
  -- Frozen from the member's rates when the entry is saved.
  bill_rate             numeric(28, 4) NOT NULL CHECK (bill_rate >= 0),
  cost_rate             numeric(28, 4) NOT NULL CHECK (cost_rate >= 0),
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'BILLED')),
  submitted_at          timestamptz,
  decided_by_user_id    uuid REFERENCES users (id),
  decided_at            timestamptz,
  reject_reason         text CHECK (reject_reason IS NULL OR length(btrim(reject_reason)) BETWEEN 1 AND 500),
  -- The draft invoice the time was billed into. Deliberately not a foreign key: drafts can be
  -- deleted, and a manager then releases the time (BILLED -> APPROVED with the link cleared).
  invoice_id            uuid,
  billed_at             timestamptz,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  CONSTRAINT project_time_entries_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT project_time_entries_project_fkey FOREIGN KEY (project_id, organization_id)
    REFERENCES projects (id, organization_id),
  CONSTRAINT project_time_entries_billed CHECK ((status = 'BILLED') = (invoice_id IS NOT NULL)),
  CONSTRAINT project_time_entries_rejected CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL)
);
CREATE INDEX project_time_entries_project_idx ON project_time_entries (organization_id, project_id, work_date);
CREATE INDEX project_time_entries_user_idx ON project_time_entries (organization_id, user_id, work_date);

-- An entry moves forward only: DRAFT -> SUBMITTED -> APPROVED|REJECTED; REJECTED -> SUBMITTED again
-- after editing; APPROVED -> BILLED; BILLED -> APPROVED only to release time whose invoice is gone
-- (the link is cleared). Figures (hours, rates, date, project, user) never change after SUBMITTED;
-- an entry is deleted only while DRAFT or REJECTED.
CREATE FUNCTION project_guard_time_entry() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('DRAFT', 'REJECTED') THEN
      RAISE EXCEPTION 'time entry % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'BILLED' AND NOT (
       NEW.status = 'BILLED' AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
       OR NEW.status = 'APPROVED' AND NEW.invoice_id IS NULL AND NEW.billed_at IS NULL) THEN
    RAISE EXCEPTION 'billed time entry % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    OLD.status = 'BILLED' AND NEW.status IN ('BILLED', 'APPROVED') OR
    (OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'SUBMITTED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED', 'APPROVED', 'REJECTED'))
    OR (OLD.status = 'REJECTED' AND NEW.status IN ('REJECTED', 'DRAFT', 'SUBMITTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'BILLED'))
  ) THEN
    RAISE EXCEPTION 'time entry % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('SUBMITTED', 'APPROVED', 'BILLED') AND (
       NEW.project_id, NEW.user_id, NEW.work_date, NEW.hours, NEW.description, NEW.billable,
       NEW.bill_rate, NEW.cost_rate)
     IS DISTINCT FROM (
       OLD.project_id, OLD.user_id, OLD.work_date, OLD.hours, OLD.description, OLD.billable,
       OLD.bill_rate, OLD.cost_rate) THEN
    RAISE EXCEPTION 'the figures of time entry % are frozen while it is %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_time_entries_guard BEFORE UPDATE OR DELETE ON project_time_entries
  FOR EACH ROW EXECUTE FUNCTION project_guard_time_entry();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_number_sequences', 'projects', 'project_members', 'project_time_entries'
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

GRANT SELECT, INSERT, UPDATE ON project_number_sequences, projects, project_time_entries TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_members TO intuit_app;
GRANT DELETE ON project_time_entries TO intuit_app;
