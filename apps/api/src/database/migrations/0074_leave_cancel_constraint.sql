-- An approved request may be cancelled afterwards; it keeps who decided and when. The original
-- constraint (0073) tied decided_at to APPROVED/REJECTED only, which rejected that transition.
ALTER TABLE payroll_leave_requests DROP CONSTRAINT payroll_leave_requests_decided;
ALTER TABLE payroll_leave_requests ADD CONSTRAINT payroll_leave_requests_decided CHECK (
  (status IN ('APPROVED', 'REJECTED') AND decided_at IS NOT NULL)
  OR (status = 'PENDING' AND decided_at IS NULL)
  OR status = 'CANCELLED');
