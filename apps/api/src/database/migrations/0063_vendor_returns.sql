-- 0063_vendor_returns — goods returned to a supplier leave stock (master context section 18
-- "Returns", ADR 0012).
--
-- A posted vendor credit (or debit note) that carries a stock-tracked item credits that item's
-- inventory account. Until now Purchases refused tracked items on vendor credits. From this
-- migration the stock ledger follows the credit: posting removes the returned quantity at the
-- value the credit's journal booked to the inventory account (so stock stays equal to the ledger),
-- and voiding the credit puts the quantity back at the same value. No table is added: the two new
-- movement kinds are the whole schema change.

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check CHECK (kind IN
  ('purchase', 'purchase_void', 'sale', 'sale_void', 'adjustment', 'adjustment_void',
   'sales_return', 'sales_return_void', 'purchase_return', 'purchase_return_void'));
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_void_link;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_void_link CHECK (
  (kind IN ('purchase_void', 'sale_void', 'adjustment_void', 'sales_return_void',
            'purchase_return_void')) = (reverses_id IS NOT NULL));
