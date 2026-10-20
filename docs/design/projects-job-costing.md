# Design: projects, time tracking and job costing (FP-26)

Status: design only; no ADR approved.

## Approach

A project is a **dimension-backed cost object** plus a small table of project facts. Costs and revenue reach the project through the existing dimension tagging on bills, expenses, invoices and journals, so project profitability is a dimension-filtered report on the posted ledger and cannot disagree with the books.

## Data model

- `projects`: id, number, name, customer id (optional), status (`PLANNED | ACTIVE | ON_HOLD | COMPLETED | CANCELLED`), start/end dates, budget amount, billing method (`fixed | time_and_materials | non_billable`), dimension value id (created with the project in a system dimension type `project`), version.
- `project_tasks` (optional breakdown) and `project_members` (who may log time).
- `time_entries`: project, task, user, work date, hours (numeric), billable flag, hourly cost rate and bill rate (frozen at entry), status (`DRAFT | SUBMITTED | APPROVED | BILLED | REJECTED`), invoice line link once billed.
- `project_budgets`: per account category per period (later).

## Flows

1. Log time → submit → approve (manager). Approved billable entries can be pulled into a draft invoice (lines carry the project dimension); the entry is marked `BILLED` and cannot be billed twice (unique link).
2. Costs: a bill/expense line with the project dimension counts as project cost; payroll costs of logged hours can be allocated later (needs payroll).
3. Reports: project P&L (revenue, cost, margin), budget versus actual, unbilled time, time by member. All derived from posted data plus approved time.

## Rules

Closed or cancelled projects accept no new time. Time entries are never deleted after approval (void/reject only). Rates are frozen at entry. Permissions: `projects.view/manage`, `projects.time.log/approve`, `projects.reports.view`.

## Open decisions

Rate cards (per member or per role); whether unapproved time may be billed; whether project revenue recognition is invoice-based only (proposed: yes); WIP accounting (out of scope until requested).
