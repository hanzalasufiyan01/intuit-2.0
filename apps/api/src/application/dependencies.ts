import type { Database } from '../database/client.js';
import type { AppConfig } from '../infrastructure/config/config.js';
import type { Clock } from '../infrastructure/clock.js';
import type { EmailProvider } from '../infrastructure/email/email-provider.js';
import type { PasswordHasher } from '../infrastructure/security/password-hasher.js';

/** Minimal logger contract used by application services (satisfied by pino / Fastify). */
export interface AppLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AppDependencies {
  db: Database;
  config: AppConfig;
  clock: Clock;
  passwordHasher: PasswordHasher;
  emailProvider: EmailProvider;
  logger: AppLogger;
}
