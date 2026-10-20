# Cash-basis reports (FP-22): method and open policy questions

Status: cash-basis **profit and loss** is implemented (`GET /accounting/reports/profit-and-loss-cash-basis`). A cash-basis balance sheet is NOT provided (no agreed definition; see below).

## Method

Revenue and expense are recognised when they are settled, not when documents are issued.

| Source                                                  | Recognised                            | Amount                                                                                            |
| ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sales invoice                                           | on each receipt / applied credit date | the invoice journal's revenue and expense lines times (base amount relieved / invoice base total) |
| Sales credit note                                       | on each application date              | its lines times (base amount of the credit used / credit note base total)                         |
| Purchase bill                                           | on each payment / applied credit date | its lines times (base amount relieved / bill base total)                                          |
| Vendor credit                                           | on each application date              | its lines times (base amount used / vendor credit base total)                                     |
| Any other journal touching a revenue or expense account | on its own entry date, as booked      | the journal's base amounts                                                                        |

- Reversed settlements (voided receipts and payments) are stored as negative allocations, so they un-recognise on the void date.
- The journals of the four document types and their void reversals are excluded from "as booked", so nothing is counted twice.
- Tax lines, receivables, payables and bank accounts are balance sheet accounts and are not part of the profit and loss.
- The statement layout, sections and totals are the accrual profit and loss builder's, so the two reports are directly comparable. Dimension filters and comparison columns are not supported in v1.

## Open policy questions (for the accountant / owner; nothing here is a tax rule)

1. **Depreciation** and other non-cash charges are "other journals" and are recognised as booked. A strict cash basis would exclude them.
2. **Inventory cost of sales** is posted separately from the sales invoice and is recognised as booked (on the sale date), not when the invoice is paid. A strict cash basis recognises stock purchases when paid.
3. **Payroll** is recognised when the run is posted (as booked), not when the payslips are paid.
4. **Customer refunds / vendor refunds** are cash movements against receivables or payables and are not recognised as revenue or expense.
5. **Deposits and prepayments** (receipts with no invoice) are customer credit until applied; they are not revenue until applied.
6. **Cash-basis balance sheet**: omitted. It needs an agreed treatment of receivables/payables (usually excluded) and of retained earnings; it must not be offered without that decision.
7. Whether tax authorities in the Maldives accept or require a cash basis for any return is **not** addressed here and is a tax decision (see `tax-localization-open-decisions.md`).

The report states its method in the response (`method`) so every client can show it next to the figures.
