import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getOrganization } from '../modules/organizations/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  getShareLink,
  insertShareLink,
  listShareLinks,
  openShareLink,
  revokeShareLink,
  SalesExtraPermissions,
} from '../modules/sales-extras/index.js';
import { getInvoice, getInvoiceLines, openInvoicesAsOf } from '../modules/sales/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Read-only invoice share links (FP-28, migration 0070): the safe first step of a customer portal.
 * A link opens ONE issued invoice for whoever holds its token: no account, no other document,
 * nothing can be changed. Only the token's hash is stored; the token is shown once. A link expires,
 * can be revoked, and counts its views. Invalid, expired and revoked tokens are indistinguishable.
 * Customer accounts, statements and online payment are separate decisions (see the matrix).
 */

const DAY = 86_400_000;
const MAX_DAYS = 90;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class InvoiceShareService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private view(l: Awaited<ReturnType<typeof getShareLink>> & object) {
    const now = this.now;
    return {
      id: l.id,
      invoiceId: l.invoiceId,
      status: l.revokedAt ? 'revoked' : l.expiresAt <= now ? 'expired' : 'active',
      expiresAt: l.expiresAt.toISOString(),
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    };
  }

  create(
    principal: Principal,
    invoiceId: string,
    input: { expiresInDays: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, sensitive: true },
      async (tx, ctx) => {
        const invoice = await getInvoice(tx, ctx.organizationId, invoiceId);
        if (!invoice) throw new NotFoundError('Invoice not found.');
        if (invoice.status !== 'ISSUED') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Only an issued invoice can be shared.',
          );
        }
        const token = randomBytes(32).toString('base64url');
        const now = this.now;
        const link = await insertShareLink(tx, {
          organizationId: ctx.organizationId,
          invoiceId,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + Math.min(input.expiresInDays, MAX_DAYS) * DAY),
          createdByUserId: ctx.userId,
          createdAt: now,
        });
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invoice.share_link_created',
          resourceType: 'sales_invoice',
          resourceId: invoiceId,
          // Never the token or its hash.
          metadata: { linkId: link.id, expiresAt: link.expiresAt.toISOString() },
          origin,
        });
        return {
          ...this.view(link),
          token,
          url: `${this.deps.config.webOrigin.replace(/\/$/, '')}/p/invoice/${token}`,
        };
      },
    );
  }

  list(principal: Principal, invoiceId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await getInvoice(tx, ctx.organizationId, invoiceId))) {
          throw new NotFoundError('Invoice not found.');
        }
        return (await listShareLinks(tx, ctx.organizationId, invoiceId)).map((l) => this.view(l));
      },
    );
  }

  revoke(principal: Principal, id: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, sensitive: true },
      async (tx, ctx) => {
        const link = await getShareLink(tx, ctx.organizationId, id, { forUpdate: true });
        if (!link) throw new NotFoundError('Share link not found.');
        if (link.revokedAt) {
          throw new ConflictError('INVALID_STATE_TRANSITION', 'The link is already revoked.');
        }
        const revoked = await revokeShareLink(tx, ctx.organizationId, id, ctx.userId, this.now);
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invoice.share_link_revoked',
          resourceType: 'sales_invoice',
          resourceId: link.invoiceId,
          metadata: { linkId: id },
          origin,
        });
        return this.view(revoked!);
      },
    );
  }

  /**
   * The public, session-less read. The token resolves (and counts a view) through a narrow
   * database function; the invoice is then read under its organization's row-level security. Any
   * failure answers the same "not found".
   */
  async open(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundError('This link is not valid.');
    const now = this.now;
    const target = await inTransaction(this.deps.db, {}, (tx) =>
      openShareLink(tx, hashToken(token), now),
    );
    if (!target) throw new NotFoundError('This link is not valid.');
    return inTransaction(this.deps.db, { organizationId: target.organizationId }, async (tx) => {
      const invoice = await getInvoice(tx, target.organizationId, target.invoiceId);
      if (!invoice) throw new NotFoundError('This link is not valid.');
      const [organization, customer] = await Promise.all([
        getOrganization(tx, target.organizationId),
        getCustomer(tx, target.organizationId, invoice.customerId),
      ]);
      const party = customer
        ? await getParty(tx, target.organizationId, customer.partyId)
        : undefined;
      const base = {
        organizationName: organization?.name ?? '',
        number: invoice.number,
        status: invoice.status,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        currencyCode: invoice.currencyCode,
        customerName: party?.displayName ?? '',
      };
      if (invoice.status !== 'ISSUED') return { ...base, voided: true as const };
      const lines = await getInvoiceLines(tx, target.organizationId, invoice.id);
      const open = (
        await openInvoicesAsOf(tx, {
          organizationId: target.organizationId,
          asOf: now.toISOString().slice(0, 10),
          customerId: invoice.customerId,
        })
      ).find((i) => i.id === invoice.id);
      return {
        ...base,
        voided: false as const,
        reference: invoice.reference,
        subtotal: decimal(invoice.subtotal).toFixed(),
        discountTotal: decimal(invoice.discountTotal).toFixed(),
        taxTotal: decimal(invoice.taxTotal).toFixed(),
        total: decimal(invoice.total).toFixed(),
        amountDue: decimal(open?.openAmount ?? 0).toFixed(),
        lines: lines.map((l) => ({
          description: l.description,
          quantity: decimal(l.quantity).toFixed(),
          unitPrice: decimal(l.unitPrice).toFixed(),
          netAmount: decimal(l.netAmount).toFixed(),
          taxAmount: decimal(l.taxAmount).toFixed(),
          total: decimal(l.total).toFixed(),
        })),
      };
    });
  }
}
