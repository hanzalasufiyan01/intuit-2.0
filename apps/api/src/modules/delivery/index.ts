/**
 * Delivery notes and stock reservations (migration 0091, master specification sections 12 and 18).
 * Fulfilment records and advisory holds only: neither moves stock nor posts to the ledger.
 */
import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

export type DeliveryStatus = 'DRAFT' | 'DELIVERED' | 'VOID';

export type DeliveryNoteRow = {
  id: string;
  number: string;
  orderId: string;
  deliveryDate: string;
  status: DeliveryStatus;
  memo: string;
  deliveredAt: string | null;
  voidReason: string | null;
  version: number;
};
export interface DeliveryLineRow {
  lineNo: number;
  orderLineNo: number;
  quantity: string;
}

const NOTE_COLUMNS = sql`id, number, order_id AS "orderId", delivery_date::text AS "deliveryDate", status, memo,
  delivered_at::text AS "deliveredAt", void_reason AS "voidReason", version`;

export async function takeNextDeliveryNumber(tx: Transaction, organizationId: string) {
  await tx.execute(sql`INSERT INTO delivery_number_sequences (organization_id) VALUES (${organizationId})
    ON CONFLICT DO NOTHING`);
  const result = await tx.execute<{ prefix: string; min_digits: number; next_number: string }>(sql`
    UPDATE delivery_number_sequences SET next_number = next_number + 1
     WHERE organization_id = ${organizationId}
 RETURNING prefix, min_digits, next_number::text AS next_number`);
  const row = result.rows[0]!;
  const value = BigInt(row.next_number) - 1n;
  return `${row.prefix}${value.toString().padStart(row.min_digits, '0')}`;
}

export async function insertDeliveryNote(
  tx: Transaction,
  input: {
    organizationId: string;
    number: string;
    orderId: string;
    deliveryDate: string;
    memo: string;
    userId: string;
    at: Date;
  },
) {
  const result = await tx.execute<DeliveryNoteRow>(sql`
    INSERT INTO delivery_notes (organization_id, number, order_id, delivery_date, memo,
                                created_by_user_id, created_at, updated_by_user_id, updated_at)
    VALUES (${input.organizationId}, ${input.number}, ${input.orderId}, ${input.deliveryDate}::date,
            ${input.memo}, ${input.userId}, ${input.at.toISOString()}::timestamptz, ${input.userId},
            ${input.at.toISOString()}::timestamptz)
    RETURNING ${NOTE_COLUMNS}`);
  return result.rows[0]!;
}

export async function getDeliveryNote(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const result = await tx.execute<DeliveryNoteRow>(
    options.forUpdate
      ? sql`SELECT ${NOTE_COLUMNS} FROM delivery_notes WHERE organization_id = ${organizationId} AND id = ${id} FOR UPDATE`
      : sql`SELECT ${NOTE_COLUMNS} FROM delivery_notes WHERE organization_id = ${organizationId} AND id = ${id}`,
  );
  return result.rows[0];
}

export async function listDeliveryNotes(
  tx: Transaction,
  organizationId: string,
  filter: { orderId?: string | undefined; limit: number },
) {
  const result = await tx.execute<DeliveryNoteRow>(sql`
    SELECT ${NOTE_COLUMNS} FROM delivery_notes
     WHERE organization_id = ${organizationId}
       AND (${filter.orderId ?? null}::uuid IS NULL OR order_id = ${filter.orderId ?? null}::uuid)
     ORDER BY delivery_date DESC, number DESC LIMIT ${filter.limit}`);
  return result.rows;
}

export async function getDeliveryLines(tx: Transaction, organizationId: string, noteId: string) {
  const result = await tx.execute<{ line_no: number; order_line_no: number; quantity: string }>(sql`
    SELECT line_no, order_line_no, quantity::text AS quantity FROM delivery_note_lines
     WHERE organization_id = ${organizationId} AND note_id = ${noteId} ORDER BY line_no`);
  return result.rows.map((r): DeliveryLineRow => ({
    lineNo: r.line_no,
    orderLineNo: r.order_line_no,
    quantity: r.quantity,
  }));
}

export async function replaceDeliveryLines(
  tx: Transaction,
  input: {
    organizationId: string;
    noteId: string;
    orderId: string;
    lines: { orderLineNo: number; quantity: string }[];
  },
) {
  await tx.execute(
    sql`DELETE FROM delivery_note_lines WHERE organization_id = ${input.organizationId} AND note_id = ${input.noteId}`,
  );
  for (const [i, l] of input.lines.entries()) {
    await tx.execute(sql`INSERT INTO delivery_note_lines
      (organization_id, note_id, line_no, order_id, order_line_no, quantity)
      VALUES (${input.organizationId}, ${input.noteId}, ${i + 1}, ${input.orderId}, ${l.orderLineNo}, ${l.quantity})`);
  }
}

export async function updateDeliveryNote(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set:
      | { deliveryDate: string; memo: string }
      | { status: 'DELIVERED'; deliveredBy: string }
      | { status: 'VOID'; reason: string; voidedBy: string };
    userId: string;
    at: Date;
  },
) {
  const at = input.at.toISOString();
  const s = input.set;
  const result = await tx.execute<DeliveryNoteRow>(
    'deliveryDate' in s
      ? sql`UPDATE delivery_notes SET delivery_date = ${s.deliveryDate}::date, memo = ${s.memo},
              version = version + 1, updated_by_user_id = ${input.userId}, updated_at = ${at}::timestamptz
            WHERE organization_id = ${input.organizationId} AND id = ${input.id} AND version = ${input.version}
        RETURNING ${NOTE_COLUMNS}`
      : s.status === 'DELIVERED'
        ? sql`UPDATE delivery_notes SET status = 'DELIVERED', delivered_by_user_id = ${s.deliveredBy},
                delivered_at = ${at}::timestamptz, version = version + 1,
                updated_by_user_id = ${input.userId}, updated_at = ${at}::timestamptz
              WHERE organization_id = ${input.organizationId} AND id = ${input.id} AND version = ${input.version}
          RETURNING ${NOTE_COLUMNS}`
        : sql`UPDATE delivery_notes SET status = 'VOID', void_reason = ${s.reason},
                voided_by_user_id = ${s.voidedBy}, voided_at = ${at}::timestamptz, version = version + 1,
                updated_by_user_id = ${input.userId}, updated_at = ${at}::timestamptz
              WHERE organization_id = ${input.organizationId} AND id = ${input.id} AND version = ${input.version}
          RETURNING ${NOTE_COLUMNS}`,
  );
  return result.rows[0];
}

export async function deleteDeliveryNote(tx: Transaction, organizationId: string, id: string) {
  await tx.execute(
    sql`DELETE FROM delivery_note_lines WHERE organization_id = ${organizationId} AND note_id = ${id}`,
  );
  await tx.execute(
    sql`DELETE FROM delivery_notes WHERE organization_id = ${organizationId} AND id = ${id}`,
  );
}

/** Delivered (not void, not draft) quantity per order line, optionally leaving one note out. */
export async function deliveredQuantities(
  tx: Transaction,
  organizationId: string,
  orderId: string,
  exceptNoteId?: string,
) {
  const result = await tx.execute<{ order_line_no: number; quantity: string }>(sql`
    SELECT l.order_line_no, sum(l.quantity)::text AS quantity
      FROM delivery_note_lines l
      JOIN delivery_notes n ON n.id = l.note_id AND n.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.order_id = ${orderId} AND n.status = 'DELIVERED'
       AND (${exceptNoteId ?? null}::uuid IS NULL OR n.id <> ${exceptNoteId ?? null}::uuid)
     GROUP BY l.order_line_no`);
  return new Map(result.rows.map((r) => [r.order_line_no, r.quantity]));
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export type ReservationRow = {
  id: string;
  itemId: string;
  quantity: string;
  source: 'manual' | 'sales_order';
  orderId: string | null;
  note: string;
  expiresOn: string | null;
  status: 'ACTIVE' | 'RELEASED';
  createdAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
};

const RESERVATION_COLUMNS = sql`id, item_id AS "itemId", quantity::text AS quantity, source, order_id AS "orderId",
  note, expires_on::text AS "expiresOn", status, created_at::text AS "createdAt",
  released_at::text AS "releasedAt", release_reason AS "releaseReason"`;

export async function insertReservation(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    quantity: string;
    source: 'manual' | 'sales_order';
    orderId: string | null;
    note: string;
    expiresOn: string | null;
    userId: string;
    at: Date;
  },
) {
  const result = await tx.execute<ReservationRow>(sql`
    INSERT INTO stock_reservations (organization_id, item_id, quantity, source, order_id, note, expires_on,
                                    created_by_user_id, created_at)
    VALUES (${input.organizationId}, ${input.itemId}, ${input.quantity}, ${input.source}, ${input.orderId},
            ${input.note}, ${input.expiresOn}::date, ${input.userId}, ${input.at.toISOString()}::timestamptz)
    RETURNING ${RESERVATION_COLUMNS}`);
  return result.rows[0]!;
}

export async function getReservation(tx: Transaction, organizationId: string, id: string) {
  const result = await tx.execute<ReservationRow>(
    sql`SELECT ${RESERVATION_COLUMNS} FROM stock_reservations WHERE organization_id = ${organizationId} AND id = ${id} FOR UPDATE`,
  );
  return result.rows[0];
}

export async function listReservations(
  tx: Transaction,
  organizationId: string,
  filter: {
    itemId?: string | undefined;
    status?: 'ACTIVE' | 'RELEASED' | undefined;
    orderId?: string | undefined;
    limit: number;
  },
) {
  const result = await tx.execute<ReservationRow>(sql`
    SELECT ${RESERVATION_COLUMNS} FROM stock_reservations
     WHERE organization_id = ${organizationId}
       AND (${filter.itemId ?? null}::uuid IS NULL OR item_id = ${filter.itemId ?? null}::uuid)
       AND (${filter.orderId ?? null}::uuid IS NULL OR order_id = ${filter.orderId ?? null}::uuid)
       AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null}::text)
     ORDER BY created_at DESC, id LIMIT ${filter.limit}`);
  return result.rows;
}

export async function releaseReservation(
  tx: Transaction,
  input: { organizationId: string; id: string; userId: string; reason: string; at: Date },
) {
  await tx.execute(sql`
    UPDATE stock_reservations SET status = 'RELEASED', released_at = ${input.at.toISOString()}::timestamptz,
           released_by_user_id = ${input.userId}, release_reason = ${input.reason}
     WHERE organization_id = ${input.organizationId} AND id = ${input.id} AND status = 'ACTIVE'`);
}

/** Releases every active reservation of an order (used when the order is cancelled). */
export async function releaseOrderReservations(
  tx: Transaction,
  input: { organizationId: string; orderId: string; userId: string; reason: string; at: Date },
) {
  const result = await tx.execute<{ id: string }>(sql`
    UPDATE stock_reservations SET status = 'RELEASED', released_at = ${input.at.toISOString()}::timestamptz,
           released_by_user_id = ${input.userId}, release_reason = ${input.reason}
     WHERE organization_id = ${input.organizationId} AND order_id = ${input.orderId} AND status = 'ACTIVE'
 RETURNING id`);
  return result.rows.length;
}
