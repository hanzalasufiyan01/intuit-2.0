import { randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getOrganization } from '../modules/organizations/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  getStatementLink,
  insertStatementLink,
  listStatementLinks,
  openStatementLink,
  revokeStatementLink,
  SalesExtraPermissions,
  type StatementLink,
} from '../modules/sales-extras/index.js';
import { listReceipts, openInvoicesAsOf } from '../modules/sales/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { hashToken } from './invoice-share-service.js';
import { withOrganization } from './organization-service.js';
import type { PaymentGatewayService } from './payment-gateway-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Customer statement links (customer portal v1, migration 0076). A link shows ONE customer's open
 * issued invoices, their recent receipts and a pay action to whoever holds the token. Nothing can
 * be changed through it except starting a payment, which goes through the payment gateway and its
 * rules. Only the token's hash is stored; invalid, expired and revoked tokens look the same.
 */

const DAY = 86_400_000;
const MAX_DAYS = 90;
const RECENT_RECEIPTS = 20;

export class CustomerStatementService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly payments: PaymentGatewayService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private view(l: StatementLink) {
    const now = this.now;
    return {
      id: l.id,
      customerId: l.customerId,
      status: l.revokedAt ? 'revoked' : l.expiresAt <= now ? 'expired' : 'active',
      expiresAt: l.expiresAt.toISOString(),
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    };
  }

  create(
    principal: Principal,
    customerId: string,
    input: { expiresInDays: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, sensitive: true },
      async (tx, ctx) => {
        if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
          throw new NotFoundError('Customer not found.');
        }
        const token = randomBytes(32).toString('base64url');
        const now = this.now;
        const link = await insertStatementLink(tx, {
          organizationId: ctx.organizationId,
          customerId,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + Math.min(input.expiresInDays, MAX_DAYS) * DAY),
          createdByUserId: ctx.userId,
          createdAt: now,
        });
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'customer.statement_link_created',
          resourceType: 'customer',
          resourceId: customerId,
          // Never the token or its hash.
          metadata: { linkId: link.id, expiresAt: link.expiresAt.toISOString() },
          origin,
        });
        return {
          ...this.view(link),
          token,
          url: `${this.deps.config.webOrigin.replace(/\/$/, '')}/p/statement/${token}`,
        };
      },
    );
  }

  list(principal: Principal, customerId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
          throw new NotFoundError('Customer not found.');
        }
        return (await listStatementLinks(tx, ctx.organizationId, customerId)).map((l) =>
          this.view(l),
        );
      },
    );
  }

  revoke(principal: Principal, id: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.LinksManage, sensitive: true },
      async (tx, ctx) => {
        const link = await getStatementLink(tx, ctx.organizationId, id, { forUpdate: true });
        if (!link) throw new NotFoundError('Statement link not found.');
        if (link.revokedAt) {
          throw new ConflictError('INVALID_STATE_TRANSITION', 'The link is already revoked.');
        }
        const revoked = await revokeStatementLink(tx, ctx.organizationId, id, ctx.userId, this.now);
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'customer.statement_link_revoked',
          resourceType: 'customer',
          resourceId: link.customerId,
          metadata: { linkId: id },
          origin,
        });
        return this.view(revoked!);
      },
    );
  }

  private async resolve(token: string, countView: boolean) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundError('This link is not valid.');
    const target = await inTransaction(this.deps.db, {}, (tx) =>
      openStatementLink(tx, hashToken(token), this.now, countView),
    );
    if (!target) throw new NotFoundError('This link is not valid.');
    return target;
  }

  /** The public read: no session. */
  async open(token: string, origin: EventOrigin) {
    const target = await this.resolve(token, true);
    const asOf = this.now.toISOString().slice(0, 10);
    const orgScope = { organizationId: target.organizationId };
    const openInvoices = () =>
      inTransaction(this.deps.db, orgScope, (tx) =>
        openInvoicesAsOf(tx, {
          organizationId: target.organizationId,
          asOf,
          customerId: target.customerId,
        }),
      );
    // First settle what the provider already knows about waiting payments (this can record a
    // receipt), then read the statement, so it is current. Standard and opening invoices are both
    // payable.
    const statuses = await this.payments.latestPublicStatuses(
      target.organizationId,
      (await openInvoices()).map((i) => i.id),
      origin,
    );
    const statement = await inTransaction(this.deps.db, orgScope, async (tx) => {
      const customer = await getCustomer(tx, target.organizationId, target.customerId);
      if (!customer) throw new NotFoundError('This link is not valid.');
      const [organization, party, open, receipts] = await Promise.all([
        getOrganization(tx, target.organizationId),
        getParty(tx, target.organizationId, customer.partyId),
        openInvoicesAsOf(tx, {
          organizationId: target.organizationId,
          asOf,
          customerId: target.customerId,
        }),
        listReceipts(tx, {
          organizationId: target.organizationId,
          status: 'RECORDED',
          customerId: target.customerId,
          search: null,
          withCredit: false,
          limit: RECENT_RECEIPTS,
          after: null,
        }),
      ]);
      return { organization, party, open, receipts: receipts.items };
    });
    const open = statement.open;
    const balances = new Map<string, ReturnType<typeof decimal>>();
    for (const i of open) {
      balances.set(i.currencyCode, (balances.get(i.currencyCode) ?? decimal(0)).plus(i.openAmount));
    }
    const byInvoice = new Map(statuses.map((s) => [s.invoiceId, s.payment]));
    return {
      organizationName: statement.organization?.name ?? '',
      customerName: statement.party?.displayName ?? '',
      asOf,
      balances: [...balances.entries()].map(([currencyCode, amount]) => ({
        currencyCode,
        amount: amount.toFixed(),
      })),
      invoices: open.map((i) => ({
        id: i.id,
        number: i.number,
        kind: i.kind,
        invoiceDate: i.invoiceDate,
        dueDate: i.dueDate,
        currencyCode: i.currencyCode,
        total: decimal(i.total).toFixed(),
        openAmount: decimal(i.openAmount).toFixed(),
        payment: byInvoice.get(i.id) ?? null,
      })),
      receipts: statement.receipts.map((r) => ({
        number: r.number,
        receiptDate: r.receiptDate,
        currencyCode: r.currencyCode,
        amount: decimal(r.amount).toFixed(),
        reference: r.reference,
      })),
    };
  }

  /** Starts a payment for one open invoice of the statement's customer. */
  async pay(token: string, invoiceId: string, origin: EventOrigin) {
    const target = await this.resolve(token, false);
    return this.payments.payFromStatement(
      target.organizationId,
      target.customerId,
      invoiceId,
      origin,
    );
  }
}
