import type { Transaction } from '../database/client.js';
import type { EventOrigin } from '../modules/audit/index.js';
import type { AuthorizationContext } from './authorization.js';

/**
 * What Purchases and Sales call into Inventory (additive integration: the bill, invoice and void
 * flows call these inside their own transaction; their posting is unchanged). Implemented by the
 * inventory service.
 */
export interface InventoryHooks {
  /**
   * A bill line of a tracked item must post to the item's inventory account, and a line that is
   * not a tracked item must not post to an account that holds tracked stock. Throws a validation
   * error naming the lines.
   */
  assertBillLines(
    tx: Transaction,
    organizationId: string,
    lines: readonly { itemId: string | null; accountId: string | null }[],
    noun?: string,
  ): Promise<void>;

  /** Refuses tracked items on a document that cannot move stock yet (expenses, vendor credits). */
  assertNoTrackedItems(
    tx: Transaction,
    organizationId: string,
    lines: readonly { itemId: string | null }[],
    noun: string,
  ): Promise<void>;

  /** Stock enters at the cost the bill posted to the inventory accounts. */
  receiveBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      billId: string;
      date: string;
      journalId: string;
      lines: readonly {
        itemId: string | null;
        quantity: string;
        netAmount: string;
        nonRecoverableTax: string;
      }[];
    },
  ): Promise<void>;

  /**
   * Goods returned to a supplier on a posted vendor credit leave stock at the value the credit's
   * journal booked to the inventory account.
   */
  returnToVendor(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      vendorCreditId: string;
      date: string;
      journalId: string;
      lines: readonly {
        itemId: string | null;
        quantity: string;
        netAmount: string;
        nonRecoverableTax: string;
      }[];
    },
  ): Promise<void>;

  /** Puts the goods of a voided vendor credit back into stock at the value they left. */
  voidVendorReturn(
    tx: Transaction,
    ctx: AuthorizationContext,
    vendorCreditId: string,
  ): Promise<void>;

  /** Removes the stock a bill brought (refused when it has been sold). */
  voidBill(tx: Transaction, ctx: AuthorizationContext, billId: string): Promise<void>;

  /** Issues the stock an invoice sells at the average cost and posts the cost of goods sold. */
  issueInvoice(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      invoiceId: string;
      number: string;
      date: string;
      dimensionValueIds: readonly string[];
      lines: readonly {
        itemId: string | null;
        quantity: string;
        dimensionValueIds: readonly string[];
      }[];
    },
    origin: EventOrigin,
  ): Promise<void>;

  /** Returns the stock of a voided invoice at its original cost and reverses the cost journal. */
  voidInvoice(
    tx: Transaction,
    ctx: AuthorizationContext,
    invoiceId: string,
    reason: string,
    origin: EventOrigin,
  ): Promise<void>;
}
