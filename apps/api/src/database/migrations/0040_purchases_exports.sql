-- 0040_purchases_exports — Phase 4B-8: Purchases exports (ADR 0004 P4-48, PD2, PD8).
--
-- The export framework (S6) records each export with its domain; the domain list is a CHECK. This
-- migration only extends that list with the Purchases exports: vendors, bills, vendor credits,
-- vendor payments, AP aging, purchases by vendor and the full payment register. No table,
-- permission or accounting object is created or changed; exports are read-only CSV files made
-- through the existing job and file services under the view permission of each screen.

ALTER TABLE exports DROP CONSTRAINT exports_domain_check;
ALTER TABLE exports ADD CONSTRAINT exports_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors', 'opening_balances',
  'customers', 'sales_items', 'invoices', 'receipts', 'ar_aging',
  'vendors', 'bills', 'vendor_credits', 'vendor_payments', 'ap_aging', 'purchases_by_vendor',
  'payment_register'));
