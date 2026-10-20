import { createHash, randomUUID } from 'node:crypto';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, isSupportedCurrency, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  findPaymentEvent,
  getGatewaySettings,
  getIntent,
  getOpenIntentForInvoice,
  insertIntent,
  insertPaymentEvent,
  listIntentEvents,
  listIntents,
  lookupIntentByProviderRef,
  PaymentPermissions,
  saveGatewaySettings,
  staleIntents,
  updateIntent,
  type GatewayMode,
  type GatewaySettings,
  type IntentStatus,
  type PaymentIntent,
} from '../modules/payments/index.js';
import { openShareLink } from '../modules/sales-extras/index.js';
import { getInvoice, openInvoicesAsOf, SalesPermissions } from '../modules/sales/index.js';
import type {
  PaymentProvider,
  ProviderChargeState,
  ProviderEvent,
} from '../infrastructure/payments/provider.js';
import {
  hasPermission,
  resolveActingUserContext,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { systemOrigin } from './job-service.js';
import { withOrganization } from './organization-service.js';
import type { ReceiptService } from './receipt-service.js';
import { hashToken } from './invoice-share-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * The online payment gateway (migration 0075). Provider-neutral: the application only ever talks
 * to a `PaymentProvider`. The one provider is a deterministic mock; no real provider is
 * configured, and `live` mode is refused until one is.
 *
 * Rules that matter:
 * - A payment becomes real only through a VERIFIED provider event that is also CONFIRMED against
 *   the provider's own record of the charge (amount, currency, status). A redirect back from a
 *   checkout page, or a browser asking, never marks anything paid; it can only trigger the same
 *   confirmation.
 * - A provider event id is processed at most once (unique ledger), and the intent row is locked
 *   while an event is applied, so duplicate and concurrent deliveries cannot record two receipts.
 * - Money received is never dropped: a business problem while recording (closed period, missing
 *   deposit account, revoked permission) parks the intent as REQUIRES_REVIEW with the reason, for
 *   a person to fix and reconcile again.
 */

const SWEEP_AFTER_MS = 15 * 60_000;
const SWEEP_BATCH = 50;

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The settings changed; reload them and try again.');

export interface GatewaySettingsInput {
  version: number;
  mode: GatewayMode;
  intentTtlMinutes: number;
}

export type ProcessOutcome = 'applied' | 'duplicate' | 'ignored' | 'rejected' | 'failed';

const hashPayload = (value: string) => createHash('sha256').update(value).digest('hex');

export class PaymentGatewayService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly receipts: ReceiptService,
    private readonly idempotency: IdempotencyService,
    private readonly providers: Partial<Record<'mock', PaymentProvider>>,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private today() {
    return this.now.toISOString().slice(0, 10);
  }

  private providerFor(mode: GatewayMode): PaymentProvider | null {
    if (mode === 'mock') return this.providers.mock ?? null;
    return null; // 'live': no real provider exists in this build
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  private settingsView(row: GatewaySettings | undefined) {
    return {
      mode: (row?.mode ?? 'disabled') as GatewayMode,
      intentTtlMinutes: row?.intentTtlMinutes ?? 60,
      actingUserId: row?.actingUserId ?? null,
      version: row?.version ?? 0,
      // What this build can offer, so the UI never pretends otherwise.
      available: {
        mock: Boolean(this.providers.mock),
        live: false,
      },
    };
  }

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => this.settingsView(await getGatewaySettings(tx, ctx.organizationId)),
    );
  }

  saveSettings(principal: Principal, input: GatewaySettingsInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.SettingsManage, sensitive: true },
      async (tx, ctx) => {
        if (input.mode === 'live') {
          throw new ValidationError([
            {
              path: 'mode',
              message: 'No live payment provider is configured. Only the simulated mode exists.',
            },
          ]);
        }
        if (input.mode === 'mock' && !this.providers.mock) {
          throw new ValidationError([
            {
              path: 'mode',
              message: 'The simulated payment provider is not enabled on this server.',
            },
          ]);
        }
        if (input.mode !== 'disabled' && !hasPermission(ctx, SalesPermissions.ReceiptsCreate)) {
          throw new ValidationError([
            {
              path: 'mode',
              message:
                'Payments are recorded as receipts under your account: you need permission to record receipts.',
            },
          ]);
        }
        const before = await getGatewaySettings(tx, ctx.organizationId);
        if ((before?.version ?? 0) !== input.version) throw versionConflict();
        const row = await saveGatewaySettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          values: {
            mode: input.mode,
            // Whoever switches the gateway on (or changes it) is the member under whom
            // confirmed payments are recorded.
            actingUserId: input.mode === 'disabled' && before ? before.actingUserId : ctx.userId,
            intentTtlMinutes: input.intentTtlMinutes,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!row) throw versionConflict();
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'payment.gateway_settings_updated',
          resourceType: 'payment_gateway_settings',
          resourceId: ctx.organizationId,
          metadata: {
            from: before?.mode ?? 'disabled',
            to: row.mode,
            intentTtlMinutes: row.intentTtlMinutes,
          },
          origin,
        });
        return this.settingsView(row);
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  private view(i: PaymentIntent) {
    return {
      id: i.id,
      invoiceId: i.invoiceId,
      customerId: i.customerId,
      amount: decimal(i.amount).toFixed(),
      currencyCode: i.currencyCode,
      provider: i.provider,
      mode: i.mode,
      status: i.status,
      providerRef: i.providerRef,
      checkoutUrl: i.status === 'PENDING' ? i.checkoutUrl : null,
      failureCode: i.failureCode,
      receiptId: i.receiptId,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
      completedAt: i.completedAt?.toISOString() ?? null,
      version: i.version,
    };
  }

  list(
    principal: Principal,
    filter: { invoiceId?: string | undefined; status?: IntentStatus | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) =>
        (await listIntents(tx, ctx.organizationId, filter)).map((i) => this.view(i)),
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const intent = await getIntent(tx, ctx.organizationId, id);
        if (!intent) throw new NotFoundError('Payment not found.');
        const events = await listIntentEvents(tx, ctx.organizationId, id);
        return {
          ...this.view(intent),
          events: events.map((e) => ({
            id: e.id,
            providerEventId: e.providerEventId,
            type: e.eventType,
            source: e.source,
            outcome: e.outcome,
            detail: e.detail,
            amount: e.amount === null ? null : decimal(e.amount).toFixed(),
            receivedAt: e.receivedAt.toISOString(),
          })),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Starting a payment
  // ---------------------------------------------------------------------------------------------

  create(
    principal: Principal,
    input: { invoiceId: string; amount?: string | undefined },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.IntentsCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'payments.intent.create', request: input },
          async () =>
            this.view(
              await this.createInTransaction(
                tx,
                ctx.organizationId,
                {
                  invoiceId: input.invoiceId,
                  amount: input.amount,
                  createdByUserId: ctx.userId,
                  shareLinkId: null,
                },
                origin,
              ),
            ),
        ),
    );
  }

  /**
   * The customer-facing start: whoever holds a live share link may pay that one invoice, in full.
   * Every failure about the link answers the same "not valid".
   */
  async createFromShareLink(token: string, origin: EventOrigin) {
    const target = await this.resolveToken(token);
    return inTransaction(this.deps.db, { organizationId: target.organizationId }, async (tx) =>
      this.view(
        await this.createInTransaction(
          tx,
          target.organizationId,
          {
            invoiceId: target.invoiceId,
            amount: undefined,
            createdByUserId: null,
            shareLinkId: target.linkId,
          },
          origin,
        ),
      ),
    );
  }

  private async resolveToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundError('This link is not valid.');
    const target = await inTransaction(this.deps.db, {}, (tx) =>
      openShareLink(tx, hashToken(token), this.now),
    );
    if (!target) throw new NotFoundError('This link is not valid.');
    return target;
  }

  private async createInTransaction(
    tx: Transaction,
    organizationId: string,
    input: {
      invoiceId: string;
      amount: string | undefined;
      createdByUserId: string | null;
      shareLinkId: string | null;
    },
    origin: EventOrigin,
  ): Promise<PaymentIntent> {
    const settings = await getGatewaySettings(tx, organizationId);
    const provider = settings ? this.providerFor(settings.mode) : null;
    if (!settings || settings.mode === 'disabled' || !provider) {
      throw new ConflictError('CONFLICT', 'Online payments are not switched on.');
    }
    const invoice = await getInvoice(tx, organizationId, input.invoiceId, { forUpdate: true });
    if (!invoice) throw new NotFoundError('Invoice not found.');
    if (invoice.status !== 'ISSUED') {
      throw invalidState('Only an issued invoice can be paid online.');
    }
    if (!isSupportedCurrency(invoice.currencyCode)) {
      throw new ValidationError([{ path: 'invoiceId', message: 'Unsupported invoice currency.' }]);
    }
    const open = (
      await openInvoicesAsOf(tx, {
        organizationId,
        asOf: this.today(),
        customerId: invoice.customerId,
      })
    ).find((i) => i.id === invoice.id);
    const openAmount = decimal(open?.openAmount ?? 0);
    if (openAmount.lte(0)) throw invalidState('This invoice has nothing left to pay.');

    let amount = openAmount;
    if (input.amount !== undefined) {
      amount = decimal(input.amount);
      const places = minorUnits(invoice.currencyCode);
      if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > places) {
        throw new ValidationError([
          {
            path: 'amount',
            message: `Enter an amount above zero with at most ${places} decimals.`,
          },
        ]);
      }
      if (amount.gt(openAmount)) {
        throw new ValidationError([
          { path: 'amount', message: 'The amount exceeds what is open on the invoice.' },
        ]);
      }
    }

    const existing = await getOpenIntentForInvoice(tx, organizationId, invoice.id);
    if (existing) {
      if (existing.expiresAt > this.now && decimal(existing.amount).eq(amount)) return existing;
      throw invalidState(
        'A payment for this invoice is already in progress. Wait for it, or cancel it first.',
      );
    }

    const now = this.now;
    const intent = await insertIntent(tx, {
      organizationId,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      amount: amount.toFixed(4),
      currencyCode: invoice.currencyCode,
      provider: provider.key,
      mode: provider.mode,
      status: 'CREATED',
      shareLinkId: input.shareLinkId,
      createdByUserId: input.createdByUserId,
      expiresAt: new Date(now.getTime() + settings.intentTtlMinutes * 60_000),
      createdAt: now,
      updatedAt: now,
    });
    await this.audit(
      tx,
      organizationId,
      input.createdByUserId,
      'payment.intent_created',
      intent,
      origin,
      {
        invoiceId: invoice.id,
        amount: amount.toFixed(),
        currencyCode: invoice.currencyCode,
        mode: provider.mode,
        viaShareLink: input.shareLinkId !== null,
      },
    );
    try {
      const charge = await provider.createCharge({
        intentId: intent.id,
        amount: amount.toFixed(minorUnits(invoice.currencyCode)),
        currencyCode: invoice.currencyCode,
        description: `Invoice ${invoice.number}`,
      });
      return await updateIntent(tx, organizationId, intent.id, {
        status: 'PENDING',
        providerRef: charge.providerRef,
        checkoutUrl: charge.checkoutUrl,
        updatedAt: now,
      });
    } catch (error) {
      this.deps.logger.warn(
        { organizationId, intentId: intent.id, err: error },
        'Payment provider create failed',
      );
      const failed = await updateIntent(tx, organizationId, intent.id, {
        status: 'FAILED',
        failureCode: 'provider_unavailable',
        completedAt: now,
        updatedAt: now,
      });
      await this.audit(
        tx,
        organizationId,
        input.createdByUserId,
        'payment.failed',
        failed,
        origin,
        {
          failureCode: 'provider_unavailable',
        },
      );
      return failed;
    }
  }

  cancel(principal: Principal, id: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.IntentsCreate },
      async (tx, ctx) => {
        const intent = await getIntent(tx, ctx.organizationId, id, { forUpdate: true });
        if (!intent) throw new NotFoundError('Payment not found.');
        if (intent.status !== 'PENDING' && intent.status !== 'CREATED') {
          throw invalidState('Only a payment that is still waiting can be cancelled.');
        }
        const provider = this.providers[intent.provider];
        if (provider && intent.providerRef) {
          // Ask the provider first: a payment that already went through must be recorded, not
          // cancelled. The provider's answer decides.
          const state = await provider.cancelCharge(intent.providerRef);
          if (state.status === 'succeeded') {
            throw invalidState(
              'This payment was already paid at the provider. Reconcile it to record the receipt.',
            );
          }
        }
        const updated = await updateIntent(tx, ctx.organizationId, id, {
          status: 'CANCELLED',
          completedAt: this.now,
          updatedAt: this.now,
        });
        await this.audit(
          tx,
          ctx.organizationId,
          ctx.userId,
          'payment.cancelled',
          updated,
          origin,
          {},
        );
        return this.view(updated);
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Provider events
  // ---------------------------------------------------------------------------------------------

  /**
   * A webhook delivery. Authenticated only by the provider signature over the raw body. Returns
   * what happened; an unexpected failure throws so that the provider redelivers.
   */
  async handleWebhook(
    providerKey: string,
    rawBody: string,
    headers: Record<string, string | undefined>,
    origin: EventOrigin,
  ): Promise<{ outcome: ProcessOutcome | 'unknown_payment' }> {
    const provider = providerKey === 'mock' ? this.providers.mock : undefined;
    if (!provider) throw new NotFoundError('Unknown payment provider.');
    const verified = provider.verifyWebhook(rawBody, headers);
    if (!verified.valid) {
      this.deps.logger.warn(
        { provider: providerKey, reason: verified.reason },
        'Payment webhook rejected',
      );
      throw new ValidationError([
        { path: 'signature', message: 'The webhook could not be verified.' },
      ]);
    }
    const target = await inTransaction(this.deps.db, {}, (tx) =>
      lookupIntentByProviderRef(tx, provider.key, verified.event.providerRef),
    );
    if (!target) return { outcome: 'unknown_payment' }; // acknowledged so the provider stops retrying
    const outcome = await this.process(
      target.organizationId,
      target.intentId,
      verified.event,
      'webhook',
      hashPayload(rawBody),
      null,
      origin,
    );
    return { outcome };
  }

  /**
   * Applies one provider event to an intent, exactly once. The intent is locked for the duration;
   * the event is recorded in the same transaction as its effect. A business problem while
   * recording the receipt is parked on the intent (REQUIRES_REVIEW) in a second transaction.
   */
  private async process(
    organizationId: string,
    intentId: string,
    event: ProviderEvent,
    source: 'webhook' | 'reconcile' | 'sweep',
    payloadHash: string,
    actorUserId: string | null,
    origin: EventOrigin,
  ): Promise<ProcessOutcome> {
    try {
      return await inTransaction(this.deps.db, { organizationId }, (tx) =>
        this.applyEvent(
          tx,
          organizationId,
          intentId,
          event,
          source,
          payloadHash,
          actorUserId,
          origin,
        ),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return inTransaction(this.deps.db, { organizationId }, async (tx) => {
        const intent = await getIntent(tx, organizationId, intentId, { forUpdate: true });
        if (!intent) throw error;
        let current = intent;
        if (['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(intent.status)) {
          current = await updateIntent(tx, organizationId, intentId, {
            status: 'REQUIRES_REVIEW',
            failureCode: error.code.slice(0, 100),
            updatedAt: this.now,
          });
          await this.audit(
            tx,
            organizationId,
            actorUserId,
            'payment.requires_review',
            current,
            origin,
            {
              reason: error.code,
              message: error.message.slice(0, 300),
            },
          );
        }
        const recorded = await insertPaymentEvent(tx, {
          organizationId,
          intentId,
          provider: current.provider,
          providerEventId: event.id,
          eventType: event.type,
          source,
          amount: event.amount,
          currencyCode: event.currencyCode,
          outcome: 'failed',
          detail: `${error.code}: ${error.message}`.slice(0, 500),
          payloadHash,
          receivedAt: this.now,
        });
        return recorded ? 'failed' : 'duplicate';
      });
    }
  }

  private async applyEvent(
    tx: Transaction,
    organizationId: string,
    intentId: string,
    event: ProviderEvent,
    source: 'webhook' | 'reconcile' | 'sweep',
    payloadHash: string,
    actorUserId: string | null,
    origin: EventOrigin,
  ): Promise<ProcessOutcome> {
    const intent = await getIntent(tx, organizationId, intentId, { forUpdate: true });
    if (!intent) throw new NotFoundError('Payment not found.');
    // A delivery that was already handled is acknowledged without touching anything; only an
    // attempt that failed for a business reason may be retried (the problem may be fixed now).
    const seen = await findPaymentEvent(tx, intent.provider, event.id);
    if (seen && seen.outcome !== 'failed') return 'duplicate';
    const provider = this.providers[intent.provider];
    const log = async (outcome: ProcessOutcome, detail: string | null, current: PaymentIntent) => {
      const recorded = await insertPaymentEvent(tx, {
        organizationId,
        intentId,
        provider: current.provider,
        providerEventId: event.id,
        eventType: event.type,
        source,
        amount: event.amount,
        currencyCode: event.currencyCode,
        outcome: outcome === 'duplicate' ? 'ignored' : (outcome as 'applied'),
        detail,
        payloadHash,
        receivedAt: this.now,
      });
      return recorded ? outcome : 'duplicate';
    };

    if (event.type === 'charge.succeeded') {
      if (intent.status === 'SUCCEEDED') {
        return log('ignored', 'The payment was already recorded.', intent);
      }
      if (!provider || !intent.providerRef) {
        return log('rejected', 'No provider is available to confirm this payment.', intent);
      }
      // Confirm against the provider's own record: a webhook alone is never enough.
      const state = await provider.retrieveCharge(intent.providerRef);
      const mismatch = this.confirmationProblem(intent, event, state);
      if (mismatch === 'not_succeeded') {
        return log('rejected', 'The provider does not confirm this payment.', intent);
      }
      if (mismatch) {
        const review = await this.park(tx, organizationId, intent, mismatch, actorUserId, origin);
        return log('rejected', mismatch, review);
      }
      const receiptId = await this.recordReceipt(tx, organizationId, intent, origin);
      const done = await updateIntent(tx, organizationId, intentId, {
        status: 'SUCCEEDED',
        receiptId,
        failureCode: null,
        completedAt: this.now,
        updatedAt: this.now,
      });
      await this.audit(tx, organizationId, actorUserId, 'payment.succeeded', done, origin, {
        receiptId,
        amount: decimal(done.amount).toFixed(),
        currencyCode: done.currencyCode,
        source,
      });
      return log('applied', null, done);
    }

    if (event.type === 'charge.failed' || event.type === 'charge.cancelled') {
      if (intent.status !== 'PENDING' && intent.status !== 'CREATED') {
        return log('ignored', `The payment is already ${intent.status.toLowerCase()}.`, intent);
      }
      const status = event.type === 'charge.failed' ? 'FAILED' : 'CANCELLED';
      const done = await updateIntent(tx, organizationId, intentId, {
        status,
        failureCode: event.failureCode?.slice(0, 100) ?? null,
        completedAt: this.now,
        updatedAt: this.now,
      });
      await this.audit(
        tx,
        organizationId,
        actorUserId,
        status === 'FAILED' ? 'payment.failed' : 'payment.cancelled',
        done,
        origin,
        { failureCode: done.failureCode, source },
      );
      return log('applied', null, done);
    }
    return log('ignored', 'Unhandled event type.', intent);
  }

  /** What is wrong with a "succeeded" event compared with the provider record, if anything. */
  private confirmationProblem(
    intent: PaymentIntent,
    event: ProviderEvent,
    state: ProviderChargeState,
  ): string | null {
    if (state.status !== 'succeeded') return 'not_succeeded';
    const expected = decimal(intent.amount);
    const sameAmount = (value: string | null) => value !== null && decimal(value).eq(expected);
    if (!sameAmount(state.amount) || (event.amount !== null && !sameAmount(event.amount))) {
      return 'The amount paid does not match the amount requested.';
    }
    if (
      state.currencyCode !== intent.currencyCode ||
      (event.currencyCode !== null && event.currencyCode !== intent.currencyCode)
    ) {
      return 'The currency paid does not match the currency requested.';
    }
    return null;
  }

  private async park(
    tx: Transaction,
    organizationId: string,
    intent: PaymentIntent,
    reason: string,
    actorUserId: string | null,
    origin: EventOrigin,
  ) {
    if (!['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(intent.status)) return intent;
    const review = await updateIntent(tx, organizationId, intent.id, {
      status: 'REQUIRES_REVIEW',
      failureCode: 'amount_or_currency_mismatch',
      updatedAt: this.now,
    });
    await this.audit(tx, organizationId, actorUserId, 'payment.requires_review', review, origin, {
      reason,
    });
    return review;
  }

  /** Records the receipt of a confirmed payment under the acting user. Returns its id. */
  private async recordReceipt(
    tx: Transaction,
    organizationId: string,
    intent: PaymentIntent,
    origin: EventOrigin,
  ): Promise<string> {
    const settings = await getGatewaySettings(tx, organizationId);
    if (!settings) throw new ConflictError('CONFLICT', 'The payment gateway is not set up.');
    const ctx: AuthorizationContext = await resolveActingUserContext(
      tx,
      settings.actingUserId,
      organizationId,
    );
    if (!hasPermission(ctx, SalesPermissions.ReceiptsCreate)) {
      throw new ConflictError(
        'PERMISSION_DENIED',
        'The member who set up online payments can no longer record receipts.',
      );
    }
    // Allocate to the invoice up to what is still open; anything beyond (or all of it, when the
    // invoice was settled or voided meanwhile) becomes customer credit instead of being lost.
    const invoice = await getInvoice(tx, organizationId, intent.invoiceId);
    let allocate = decimal(0);
    if (invoice?.status === 'ISSUED') {
      const open = (
        await openInvoicesAsOf(tx, {
          organizationId,
          asOf: this.today(),
          customerId: invoice.customerId,
        })
      ).find((i) => i.id === invoice.id);
      const left = decimal(open?.openAmount ?? 0);
      allocate = left.lt(intent.amount) ? left : decimal(intent.amount);
    }
    const receipt = await this.receipts.recordForGateway(
      tx,
      ctx,
      {
        customerId: intent.customerId,
        receiptDate: this.today(),
        currencyCode: intent.currencyCode,
        amount: decimal(intent.amount).toFixed(minorUnits(intent.currencyCode)),
        reference: intent.providerRef,
        memo:
          intent.mode === 'mock'
            ? 'Online payment (SIMULATED provider; no money moved)'
            : 'Online payment',
        allocations: allocate.gt(0)
          ? [
              {
                invoiceId: intent.invoiceId,
                amount: allocate.toFixed(minorUnits(intent.currencyCode)),
              },
            ]
          : [],
      },
      origin,
    );
    return (receipt as { id: string }).id;
  }

  // ---------------------------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------------------------

  /** Asks the provider what really happened to a payment and applies it. */
  private async reconcileIntent(
    organizationId: string,
    intentId: string,
    source: 'reconcile' | 'sweep',
    actorUserId: string | null,
    origin: EventOrigin,
  ): Promise<{ outcome: ProcessOutcome | 'pending'; intent: PaymentIntent }> {
    const intent = await inTransaction(this.deps.db, { organizationId }, (tx) =>
      getIntent(tx, organizationId, intentId),
    );
    if (!intent) throw new NotFoundError('Payment not found.');
    const provider = this.providers[intent.provider];
    if (!provider || !intent.providerRef) return { outcome: 'pending', intent };
    const state = await provider.retrieveCharge(intent.providerRef);
    const base = {
      providerRef: intent.providerRef,
      amount: state.amount,
      currencyCode: state.currencyCode,
      failureCode: state.failureCode,
    };
    let event: ProviderEvent | null = null;
    if (state.status === 'succeeded') {
      event = { id: `${source}:${randomUUID()}`, type: 'charge.succeeded', ...base };
    } else if (state.status === 'failed') {
      event = { id: `${source}:${randomUUID()}`, type: 'charge.failed', ...base };
    } else if (state.status === 'cancelled') {
      event = { id: `${source}:${randomUUID()}`, type: 'charge.cancelled', ...base };
    }
    if (event) {
      if (
        intent.status === 'SUCCEEDED' ||
        (intent.status === 'FAILED' && event.type !== 'charge.succeeded')
      ) {
        return { outcome: 'ignored', intent };
      }
      const outcome = await this.process(
        organizationId,
        intentId,
        event,
        source,
        hashPayload(JSON.stringify(state)),
        actorUserId,
        origin,
      );
      const after = await inTransaction(this.deps.db, { organizationId }, (tx) =>
        getIntent(tx, organizationId, intentId),
      );
      return { outcome, intent: after ?? intent };
    }
    // Still pending (or unknown to the provider): expire it once its time is up.
    if (intent.status === 'PENDING' && intent.expiresAt <= this.now) {
      const expired = await inTransaction(this.deps.db, { organizationId }, async (tx) => {
        const locked = await getIntent(tx, organizationId, intentId, { forUpdate: true });
        if (!locked || locked.status !== 'PENDING') return locked;
        const done = await updateIntent(tx, organizationId, intentId, {
          status: 'EXPIRED',
          completedAt: this.now,
          updatedAt: this.now,
        });
        await this.audit(tx, organizationId, actorUserId, 'payment.expired', done, origin, {
          source,
        });
        return done;
      });
      if (expired) return { outcome: 'applied', intent: expired };
    }
    return { outcome: 'pending', intent };
  }

  reconcile(principal: Principal, id: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PaymentPermissions.Reconcile },
      async (tx, ctx) => {
        const intent = await getIntent(tx, ctx.organizationId, id);
        if (!intent) throw new NotFoundError('Payment not found.');
        return { organizationId: ctx.organizationId, userId: ctx.userId };
      },
    ).then(async ({ organizationId, userId }) => {
      const result = await this.reconcileIntent(organizationId, id, 'reconcile', userId, origin);
      return { outcome: result.outcome, payment: this.view(result.intent) };
    });
  }

  /** Background: checks payments that have been pending for a while. Returns how many changed. */
  async sweep(): Promise<number> {
    const stale = await inTransaction(this.deps.db, {}, (tx) =>
      staleIntents(tx, new Date(this.now.getTime() - SWEEP_AFTER_MS), SWEEP_BATCH),
    );
    let changed = 0;
    for (const { organizationId, intentId } of stale) {
      try {
        const r = await this.reconcileIntent(
          organizationId,
          intentId,
          'sweep',
          null,
          systemOrigin(`payments-sweep:${organizationId}`),
        );
        if (r.outcome !== 'pending' && r.outcome !== 'ignored') changed += 1;
      } catch (error) {
        this.deps.logger.warn({ organizationId, intentId, err: error }, 'Payment sweep failed');
      }
    }
    return changed;
  }

  /**
   * The customer returning from checkout (or reloading the invoice page) asks "did it work?".
   * Nothing is trusted from the browser: a payment that is still pending is re-checked with the
   * provider, and only that confirmation can record it.
   */
  async publicStatus(token: string, origin: EventOrigin) {
    const target = await this.resolveToken(token);
    const [latest] = await this.latestPublicStatuses(
      target.organizationId,
      [target.invoiceId],
      origin,
    );
    return { payment: latest?.payment ?? null };
  }

  /** The customer statement pay action: any open invoice of that one customer. */
  async payFromStatement(
    organizationId: string,
    customerId: string,
    invoiceId: string,
    origin: EventOrigin,
  ) {
    return inTransaction(this.deps.db, { organizationId }, async (tx) => {
      const invoice = await getInvoice(tx, organizationId, invoiceId);
      if (!invoice || invoice.customerId !== customerId) {
        throw new NotFoundError('This invoice is not on the statement.');
      }
      return this.view(
        await this.createInTransaction(
          tx,
          organizationId,
          { invoiceId, amount: undefined, createdByUserId: null, shareLinkId: null },
          origin,
        ),
      );
    });
  }

  /**
   * The latest payment attempt of each invoice as a customer may see it. A pending attempt is
   * re-checked with the provider first; "needs review" is shown only as "processing".
   */
  async latestPublicStatuses(organizationId: string, invoiceIds: string[], origin: EventOrigin) {
    const out: {
      invoiceId: string;
      payment: {
        id: string;
        status: string;
        amount: string;
        currencyCode: string;
        checkoutUrl: string | null;
      };
    }[] = [];
    for (const invoiceId of invoiceIds) {
      const latest = await inTransaction(this.deps.db, { organizationId }, async (tx) => {
        return (await listIntents(tx, organizationId, { invoiceId, limit: 1 }))[0];
      });
      if (!latest) continue;
      let intent = latest;
      if (latest.status === 'PENDING') {
        intent = (await this.reconcileIntent(organizationId, latest.id, 'reconcile', null, origin))
          .intent;
      }
      out.push({
        invoiceId,
        payment: {
          id: intent.id,
          status: intent.status === 'REQUIRES_REVIEW' ? 'PROCESSING' : intent.status,
          amount: decimal(intent.amount).toFixed(),
          currencyCode: intent.currencyCode,
          checkoutUrl: intent.status === 'PENDING' ? intent.checkoutUrl : null,
        },
      });
    }
    return out;
  }

  private async audit(
    tx: Transaction,
    organizationId: string,
    actorUserId: string | null,
    action: string,
    intent: PaymentIntent,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId,
      actorUserId,
      action,
      resourceType: 'payment_intent',
      resourceId: intent.id,
      metadata: {
        invoiceId: intent.invoiceId,
        status: intent.status,
        provider: intent.provider,
        ...metadata,
      },
      origin,
    });
  }
}
