import { buildApp } from './app.js';
import { poll } from './application/job-service.js';
import { createDatabase } from './database/client.js';
import { systemClock } from './infrastructure/clock.js';
import { loadConfig } from './infrastructure/config/config.js';
import { loadEnvFile } from './infrastructure/config/load-env.js';
import { MockEmailProvider, type EmailProvider } from './infrastructure/email/email-provider.js';
import { SmtpEmailProvider, type AttachmentRef } from './infrastructure/email/smtp-provider.js';
import { inTransaction } from './application/unit-of-work.js';
import { createArgon2idPasswordHasher } from './infrastructure/security/password-hasher.js';
import { OutboxDispatcher, startOutboxPolling } from './modules/outbox/index.js';

loadEnvFile();
const config = loadConfig();

if (config.email.provider === 'mock' && config.appEnv === 'production') {
  throw new Error('The mock email provider must not be used in production.');
}

const database = createDatabase({
  connectionString: config.database.url,
  poolMax: config.database.poolMax,
});
// Attachments are loaded when a message is delivered; the file service exists only after the app
// is built, so the SMTP provider reads it through this late-bound function.
let loadAttachment: (ref: AttachmentRef) => Promise<Buffer> = () =>
  Promise.reject(new Error('The file service is not ready yet.'));
const emailProvider: EmailProvider =
  config.email.provider === 'smtp' && config.email.smtp
    ? new SmtpEmailProvider(
        {
          host: config.email.smtp.host,
          port: config.email.smtp.port,
          security: config.email.smtp.security,
          user: config.email.smtp.user,
          password: config.email.smtp.password,
          timeoutMs: config.email.smtp.timeoutMs,
          rejectUnauthorized: config.email.smtp.rejectUnauthorized,
        },
        config.email.from,
        (ref) => loadAttachment(ref),
      )
    : new MockEmailProvider(config.email.from);

const { app, services, worker } = await buildApp({
  deps: {
    db: database.db,
    config,
    clock: systemClock,
    passwordHasher: createArgon2idPasswordHasher(),
    emailProvider,
  },
});

loadAttachment = async (ref) => {
  if (!ref.organizationId) throw new Error('An attachment needs its organization.');
  const organizationId = ref.organizationId;
  return inTransaction(database.db, { organizationId }, async (tx) => {
    const { stream } = await services.files.openStreamInTransaction(tx, organizationId, ref.fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  });
};

// Outbox dispatcher. Events with no subscriber are recorded and marked processed. The webhook
// fan-out (ADR 0011 step 6) is the first real subscriber, of the `public.*` event types only; the
// per-organization cap keeps one organization's burst from filling a whole batch (section 19.4).
const dispatcher = new OutboxDispatcher(database.db, {
  batchSize: config.outbox.batchSize,
  perOrganizationBatchCap: config.webhooks.fanOutOrganizationBatchCap,
  onError: (event, error) =>
    app.log.error(
      { outboxEventId: event.id, eventType: event.eventType, err: error },
      'Outbox handler failed',
    ),
});
services.webhookDelivery.registerFanOut(dispatcher);
const stopOutbox = startOutboxPolling(dispatcher, config.outbox.pollIntervalMs, (error) =>
  app.log.error({ err: error }, 'Outbox dispatch failed'),
);

// Background jobs (S5-17) and the hourly file purge scheduler (S5-19), in-process.
const stopJobs: (() => Promise<void>)[] = [];
if (config.jobs.workerEnabled) {
  stopJobs.push(
    worker.start((error) => app.log.error({ err: error }, 'Job worker batch failed')),
    poll(
      () => services.jobs.schedulePurges(),
      config.storage.purgeIntervalMs,
      (error) => app.log.error({ err: error }, 'File purge scheduling failed'),
    ),
    // S6-36: import/export housekeeping (expiry, 30-day redaction, stuck work).
    poll(
      () => services.dataExchangeCleanup.schedule(),
      config.dataExchange.cleanupIntervalMs,
      (error) => app.log.error({ err: error }, 'Import/export cleanup scheduling failed'),
    ),
    // ADR 0011 step 6: lost delivery jobs, stale endpoints (D6) and delivery-history retention.
    poll(
      () => services.webhookDelivery.runMaintenance(),
      config.webhooks.maintenanceIntervalMs,
      (error) => app.log.error({ err: error }, 'Webhook maintenance failed'),
    ),
    // FP-28: automatic payment reminders for organizations that switched them on.
    poll(
      () => services.reminders.runAuto(),
      config.recurring.intervalMs,
      (error) => app.log.error({ err: error }, 'Automatic payment reminders failed'),
    ),
    // Online payments: pending payments that never reported back are checked with the provider.
    poll(
      () => services.payments.sweep(),
      config.payments.sweepIntervalMs,
      (error) => app.log.error({ err: error }, 'Payment sweep failed'),
    ),
    // FP-28: recurring invoice schedules that are due create their DRAFT invoices.
    poll(
      () => services.recurring.runDue(),
      config.recurring.intervalMs,
      (error) => app.log.error({ err: error }, 'Recurring invoice run failed'),
    ),
    // Phase 3B (Decision 23): expired idempotency keys, on the file purge interval.
    poll(
      () => services.idempotency.purgeExpired(),
      config.storage.purgeIntervalMs,
      (error) => app.log.error({ err: error }, 'Idempotency key purge failed'),
    ),
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  await stopOutbox();
  await Promise.all(stopJobs.map((stop) => stop()));
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.api.host, port: config.api.port });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start');
  await database.close();
  process.exit(1);
}
