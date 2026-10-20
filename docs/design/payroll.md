# Design: payroll (FP-25)

Status: design only; no ADR approved. Country rules (pension, income tax, overtime, leave entitlements) are **configuration, not code**, and the actual Maldives values are unresolved decisions (see the end).

## Scope

Employee profiles, salary structures, earning and deduction types, pay runs, payslips, posting to the general ledger, approval, leave, advances and loans, payslip PDF and e-mail, and a payroll register report.

## Data model (all tenant tables with RLS and composite FKs)

- `payroll_employees`: id, number, display name, linked `user_id` (optional), national id (sensitive, masked in lists), hire date, termination date, status, bank account, branch/department dimension values, pay frequency.
- `payroll_pay_components`: code, name, kind (`earning` | `deduction` | `employer_contribution`), calculation (`fixed` | `percent_of_basic` | `percent_of_gross` | `per_hour` | `formula_ref`), taxable flag, expense/liability account mapping.
- `payroll_salary_structures` and `payroll_employee_components`: effective-dated assignments (no overwrite; a new row supersedes by date).
- `payroll_runs`: period, status `DRAFT → CALCULATED → PENDING_APPROVAL → APPROVED → POSTED → PAID` (+ `VOID`), totals, journal id, version.
- `payroll_payslips` and `payroll_payslip_lines`: frozen snapshot of each employee's calculation (immutable once the run is approved).
- `payroll_leave_types`, `payroll_leave_balances`, `payroll_leave_requests`; `payroll_advances` (loan/advance, schedule, recovery through deductions).

## Accounting

Posting uses an accounting event (`payroll.run_posted`) through the transactional outbox path used by other modules: Dr salary expense (per component mapping, with dimensions) / Cr net pay payable, Cr deduction liabilities, Cr employer contribution liabilities; payment is a bank payment against the net-pay payable. Void reverses through `reverseSubledgerJournalInTransaction`. Approval uses the existing approval engine with a payroll-total threshold policy. A closed period blocks posting.

## Security

New permission keys: `payroll.employees.view/manage`, `payroll.runs.create/approve/post/void`, `payroll.payslips.view` (own payslip always visible to the employee), `payroll.leave.*`. Salary data is sensitive: access is audited, exports need step-up, payslip files are stored privately. The preparer cannot approve their own run.

## Calculation engine

Pure functions with decimal arithmetic: `calculatePayslip(employee, components, period, attendance) → lines`. Rounding to base currency minor units per line, then totals. Rules are data (percent, caps, thresholds, brackets in a `payroll_rule_sets` table with effective dates).

## Unresolved decisions (must not be guessed)

1. Statutory pension/retirement contribution rates, caps and who bears them.
2. Income-tax treatment of salary (brackets, thresholds, whether the employer withholds).
3. Overtime, allowance and end-of-service/gratuity rules; working-days and leave entitlements.
4. Pay frequency, and whether pay runs are per branch or per organization.
5. Whether foreign-currency salaries are required.
6. Required statutory filings or exports.

## Build order

(1) employees and components with tests; (2) calculation engine with configurable rule sets; (3) pay run workflow and posting with accounting-invariant tests; (4) payslips PDF/e-mail; (5) leave; (6) advances/loans; (7) UI; (8) register report.
