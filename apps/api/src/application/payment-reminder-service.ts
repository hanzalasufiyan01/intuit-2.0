import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getOrganization } from '../modules/organizations/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  getReminderSettings,
  insertReminder,
  organizationsWithAutoReminders,
  remindersOfInvoices,
  saveReminderSettings,
  SalesExtraPermissions,
} from '../modules/sales-extras/index.js';
import { openInvoicesAsOf, type OpenInvoice } from '../modules/sales/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { systemOrigin } from './job-service.js';
import { withOrganization } from './organization-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Payment reminders (FP-28, migration 0070). A reminder is a plain e-mail about an overdue issued
 * invoice, recorded in an immutable log. Manual: at most one per invoice per day. Automatic (off by
 * default): stage n goes out once the invoice is `first + (n - 1) * repeat` days overdue, up to the
 * maximum, and the unique (invoice, stage) record makes a stage impossible to send twice. A
 * reminder is never sent for an invoice with nothing open, to a customer without an e-mail
 * address, or by anyone without `payment_reminders.send`.
 */

const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The settings changed; reload them and try again.');
const DAY = 86_400_000;

export interface ReminderSettingsInput {
  version: number;
  autoEnabled: boolean;
  firstAfterDays: number;
  repeatEveryDays: number;
  maxReminders: number;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export class PaymentReminderService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private today() {
    return this.now.toISOString().slice(0, 10);
  }

  private settingsView(row: Awaited<ReturnType<typeof getReminderSettings>>) {
    return {
      autoEnabled: row?.autoEnabled ?? false,
      firstAfterDays: row?.firstAfterDays ?? 3,
      repeatEveryDays: row?.repeatEveryDays ?? 7,
      maxReminders: row?.maxReminders ?? 3,
      version: row?.version ?? 0,
    };
  }

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.RemindersView, readOnlySnapshot: true },
      async (tx, ctx) => this.settingsView(await getReminderSettings(tx, ctx.organizationId)),
    );
  }

  saveSettings(principal: Principal, input: ReminderSettingsInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.RemindersSettings, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const saved = await saveReminderSettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          values: {
            autoEnabled: input.autoEnabled,
            firstAfterDays: input.firstAfterDays,
            repeatEveryDays: input.repeatEveryDays,
            maxReminders: input.maxReminders,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!saved) throw versionConflict();
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'payment_reminder.settings_updated',
          resourceType: 'payment_reminder_settings',
          resourceId: ctx.organizationId,
          metadata: {
            autoEnabled: saved.autoEnabled,
            firstAfterDays: saved.firstAfterDays,
            repeatEveryDays: saved.repeatEveryDays,
            maxReminders: saved.maxReminders,
          },
          origin,
        });
        return this.settingsView(saved);
      },
    );
  }

  private async overdueOf(tx: Transaction, organizationId: string) {
    const today = this.today();
    const open = await openInvoicesAsOf(tx, { organizationId, asOf: today });
    return open.filter((i) => i.dueDate < today && decimal(i.openAmount).gt(0));
  }

  private async recipientOf(tx: Transaction, organizationId: string, customerId: string) {
    const customer = await getCustomer(tx, organizationId, customerId);
    const party = customer ? await getParty(tx, organizationId, customer.partyId) : undefined;
    return { name: party?.displayName ?? null, email: party?.email?.trim() || null };
  }

  /** Overdue issued invoices with their customer, address and reminder history. */
  listOverdue(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.RemindersView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const overdue = await this.overdueOf(tx, ctx.organizationId);
        const history = await remindersOfInvoices(
          tx,
          ctx.organizationId,
          overdue.map((i) => i.id),
        );
        const today = this.today();
        const out = [];
        for (const invoice of overdue) {
          const who = await this.recipientOf(tx, ctx.organizationId, invoice.customerId);
          const mine = history.filter((r) => r.invoiceId === invoice.id);
          out.push({
            invoiceId: invoice.id,
            number: invoice.number,
            customerId: invoice.customerId,
            customerName: who.name,
            hasEmail: who.email !== null,
            currencyCode: invoice.currencyCode,
            dueDate: invoice.dueDate,
            daysOverdue: daysBetween(invoice.dueDate, today),
            openAmount: decimal(invoice.openAmount).toFixed(),
            remindersSent: mine.length,
            lastReminderAt: mine[0]?.sentAt.toISOString() ?? null,
          });
        }
        return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
      },
    );
  }

  private async deliver(
    tx: Transaction,
    organizationId: string,
    invoice: OpenInvoice,
    recipient: { name: string | null; email: string },
    meta: { kind: 'manual' | 'auto'; stage: number | null; userId: string | null },
    origin: EventOrigin,
  ) {
    const now = this.now;
    const daysOverdue = Math.max(0, daysBetween(invoice.dueDate, this.today()));
    // Claim first (the unique stage record), then send: a failed send rolls the claim back.
    const reminder = await insertReminder(tx, {
      organizationId,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      kind: meta.kind,
      stage: meta.stage,
      recipient: recipient.email,
      openAmount: decimal(invoice.openAmount).toFixed(4),
      currencyCode: invoice.currencyCode,
      daysOverdue,
      sentByUserId: meta.userId,
      sentAt: now,
    });
    if (!reminder) return null;
    const organization = await getOrganization(tx, organizationId);
    await this.deps.emailProvider.send({
      to: recipient.email,
      subject: `Payment reminder: invoice ${invoice.number}`,
      template: 'sales.payment_reminder',
      text:
        `Dear ${recipient.name ?? 'customer'},\n\n` +
        `Our records show that invoice ${invoice.number} was due on ${invoice.dueDate} and ` +
        `${decimal(invoice.openAmount).toFixed()} ${invoice.currencyCode} is still open ` +
        `(${daysOverdue} days overdue).\n\n` +
        `If you have already paid, please disregard this message.\n\n` +
        `${organization?.name ?? ''}`.trim(),
    });
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId,
      actorUserId: meta.userId,
      ...(meta.userId ? {} : { actorType: 'system' as const }),
      action: 'payment_reminder.sent',
      resourceType: 'sales_invoice',
      resourceId: invoice.id,
      // The address and the customer's name are not written to the audit trail.
      metadata: { kind: meta.kind, stage: meta.stage, daysOverdue, reminderId: reminder.id },
      origin,
    });
    return reminder;
  }

  /** Sends one reminder now. Refused when nothing is open, not yet due, or one went out today. */
  send(
    principal: Principal,
    invoiceId: string,
    input: { to?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.RemindersSend },
      async (tx, ctx) => {
        const overdue = await this.overdueOf(tx, ctx.organizationId);
        const invoice = overdue.find((i) => i.id === invoiceId);
        if (!invoice) {
          throw new NotFoundError('There is no overdue open invoice with this id.');
        }
        const who = await this.recipientOf(tx, ctx.organizationId, invoice.customerId);
        const to = (input.to ?? who.email ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          throw new ValidationError([
            { path: 'to', message: 'The customer has no e-mail address: enter one to send to.' },
          ]);
        }
        const history = await remindersOfInvoices(tx, ctx.organizationId, [invoice.id]);
        const last = history.find((r) => r.kind === 'manual');
        if (last && this.now.getTime() - last.sentAt.getTime() < DAY) {
          throw new ConflictError(
            'CONFLICT',
            'A reminder for this invoice was already sent in the last 24 hours.',
          );
        }
        const reminder = await this.deliver(
          tx,
          ctx.organizationId,
          invoice,
          { name: who.name, email: to },
          { kind: 'manual', stage: null, userId: ctx.userId },
          origin,
        );
        return { reminderId: reminder!.id, sentTo: to, sentAt: reminder!.sentAt.toISOString() };
      },
    );
  }

  /**
   * The automatic schedule, for every organization that switched it on. Returns the number of
   * reminders sent. A failure for one organization never stops the others.
   */
  async runAuto(): Promise<number> {
    const organizations = await inTransaction(this.deps.db, {}, (tx) =>
      organizationsWithAutoReminders(tx),
    );
    let sent = 0;
    for (const organizationId of organizations) {
      try {
        sent += await inTransaction(this.deps.db, { organizationId }, async (tx) => {
          const settings = await getReminderSettings(tx, organizationId);
          if (!settings?.autoEnabled) return 0;
          const origin = systemOrigin(`reminders:${organizationId}`);
          const overdue = await this.overdueOf(tx, organizationId);
          const history = await remindersOfInvoices(
            tx,
            organizationId,
            overdue.map((i) => i.id),
          );
          let count = 0;
          for (const invoice of overdue) {
            const stage =
              history.filter((r) => r.invoiceId === invoice.id && r.kind === 'auto').length + 1;
            if (stage > settings.maxReminders) continue;
            const days = daysBetween(invoice.dueDate, this.today());
            if (days < settings.firstAfterDays + (stage - 1) * settings.repeatEveryDays) continue;
            const who = await this.recipientOf(tx, organizationId, invoice.customerId);
            if (!who.email) continue;
            const reminder = await this.deliver(
              tx,
              organizationId,
              invoice,
              { name: who.name, email: who.email },
              { kind: 'auto', stage, userId: null },
              origin,
            );
            if (reminder) count += 1;
          }
          return count;
        });
      } catch (error) {
        this.deps.logger.warn({ organizationId, err: error }, 'Automatic payment reminders failed');
      }
    }
    return sent;
  }
}
