import { buildApp } from './app.js';
import { poll } from './application/job-service.js';
import { createDatabase } from './database/client.js';
import { systemClock } from './infrastructure/clock.js';
import { loadConfig } from './infrastructure/config/config.js';
import { loadEnvFile } from './infrastructure/config/load-env.js';
import { MockEmailProvider } from './infrastructure/email/email-provider.js';
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
const emailProvider = new MockEmailProvider(config.email.from);

const { app, services, worker } = await buildApp({
  deps: {
    db: database.db,
    config,
    clock: systemClock,
    passwordHasher: createArgon2idPasswordHasher(),
    emailProvider,
  },
});

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
