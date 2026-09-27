import { buildApp } from './app.js';
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

const { app } = await buildApp({
  deps: {
    db: database.db,
    config,
    clock: systemClock,
    passwordHasher: createArgon2idPasswordHasher(),
    emailProvider,
  },
});

// Outbox dispatcher. Phase 1 registers no subscribers; events are recorded and marked processed.
const dispatcher = new OutboxDispatcher(database.db, {
  batchSize: config.outbox.batchSize,
  onError: (event, error) =>
    app.log.error(
      { outboxEventId: event.id, eventType: event.eventType, err: error },
      'Outbox handler failed',
    ),
});
const stopOutbox = startOutboxPolling(dispatcher, config.outbox.pollIntervalMs, (error) =>
  app.log.error({ err: error }, 'Outbox dispatch failed'),
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  await stopOutbox();
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
