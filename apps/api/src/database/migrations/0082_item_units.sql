-- 0082_item_units — units of measure for tracked items (FP-29 A2, ADR 0014 AI-09).
--
-- Stock is always held in the item's BASE unit. An item may have a purchase unit and a sales unit,
-- each with a factor to the base unit (for example 1 carton = 24 pieces). When an item has a
-- purchase unit, the quantities of that item on bills and vendor credits are in that unit; with a
-- sales unit, those on invoices and credit notes are. The stock hooks convert at posting
-- (quantity x factor, which must be exact to six decimals). Items without units behave as before.
-- Adjustments, counts, transfers, returns and stock reports stay in the base unit.

ALTER TABLE inventory_items
  ADD COLUMN base_unit       text NOT NULL DEFAULT 'unit' CHECK (length(btrim(base_unit)) BETWEEN 1 AND 20),
  ADD COLUMN purchase_unit   text CHECK (purchase_unit IS NULL OR length(btrim(purchase_unit)) BETWEEN 1 AND 20),
  ADD COLUMN purchase_factor numeric(28, 6) CHECK (purchase_factor IS NULL OR purchase_factor > 0),
  ADD COLUMN sales_unit      text CHECK (sales_unit IS NULL OR length(btrim(sales_unit)) BETWEEN 1 AND 20),
  ADD COLUMN sales_factor    numeric(28, 6) CHECK (sales_factor IS NULL OR sales_factor > 0),
  ADD CONSTRAINT inventory_items_purchase_unit_pair CHECK ((purchase_unit IS NULL) = (purchase_factor IS NULL)),
  ADD CONSTRAINT inventory_items_sales_unit_pair CHECK ((sales_unit IS NULL) = (sales_factor IS NULL));
