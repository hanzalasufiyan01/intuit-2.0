import type { Transaction } from '../database/client.js';
import type { EventOrigin } from '../modules/audit/index.js';
import type { MatchIssue, MatchMode } from '../modules/purchase-orders/index.js';
import type { AuthorizationContext } from './authorization.js';

/** The outcome of matching a bill to its purchase order, applied once the bill has posted. */
export interface BillMatchPlan {
  orderId: string;
  mode: MatchMode;
  status: 'matched' | 'warning';
  issues: MatchIssue[];
  /** Billed quantity to add to each order line. */
  allocations: { orderLineId: string; quantity: string }[];
}

/**
 * What the bill flows call into purchase orders (additive: the bill posting is unchanged; the
 * calls run inside its transaction). Implemented by the purchase order service.
 */
export interface PurchaseOrderHooks {
  /**
   * The three-way match of a bill about to post. Returns null when the bill is not linked to an
   * order. In `block` mode a failed match throws; in `warning` mode the issues are returned.
   */
  checkBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    bill: { id: string },
    lines: readonly {
      lineNo: number;
      itemId: string | null;
      description: string;
      quantity: string;
      amount: string;
      lineDiscount: string;
    }[],
  ): Promise<BillMatchPlan | null>;

  /** Applies the billed quantities and records the match once the bill has posted. */
  recordBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    billId: string,
    plan: BillMatchPlan,
    origin: EventOrigin,
  ): Promise<void>;

  /** Takes a voided bill's billed quantities off the order lines again. */
  releaseBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    billId: string,
    origin: EventOrigin,
  ): Promise<void>;
}
