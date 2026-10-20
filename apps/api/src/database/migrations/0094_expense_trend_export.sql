-- Export of the expense trend report (R-02; master specification section 16).
-- Forward-only: the domain check of 0043 is replaced by the same list plus 'expense_trend'.
-- No data changes; existing exports keep their domain.

ALTER TABLE exports DROP CONSTRAINT exports_domain_check;
ALTER TABLE exports ADD CONSTRAINT exports_domain_check CHECK (domain IN (
  'chart_of_accounts', 'parties', 'dimension_values', 'journals', 'general_ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'import_errors', 'opening_balances',
  'customers', 'sales_items', 'invoices', 'receipts', 'ar_aging',
  'vendors', 'bills', 'vendor_credits', 'vendor_payments', 'ap_aging', 'purchases_by_vendor',
  'payment_register', 'expenses', 'expense_trend'));
