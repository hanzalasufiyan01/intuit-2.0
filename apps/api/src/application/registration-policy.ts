import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from '../domain/errors.js';
import type { AppConfig } from '../infrastructure/config/config.js';

/**
 * Who may register a new account and organization (REGISTRATION_MODE). Invitations are a separate
 * path and are never checked here. The access code is a secret: it is compared in constant time,
 * a missing and a wrong code are indistinguishable, and nothing here logs or returns it.
 */

export type RegistrationConfig = AppConfig['registration'];

/** Attempts per minute and address while a shared code protects registration. */
export const REGISTRATION_ATTEMPTS_PER_MINUTE = 10;

/** The only thing the web app may learn: the mode. */
export function registrationPolicyView(config: RegistrationConfig): {
  mode: RegistrationConfig['mode'];
} {
  return { mode: config.mode };
}

function sameCode(expected: string, provided: string): boolean {
  // Digests have equal length, so the comparison takes the same time whatever the input.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * Throws a 403 unless registration is allowed. With `checkCode: false` only the mode is checked
 * (used to refuse a closed registration before the request body is even read).
 */
export function assertRegistrationAllowed(
  config: RegistrationConfig,
  provided: string | undefined,
  options: { checkCode?: boolean } = {},
): void {
  if (config.mode === 'closed') throw new ForbiddenError('Registration is closed.');
  if (config.mode === 'open' || options.checkCode === false) return;
  if (!config.accessCode || provided === undefined || !sameCode(config.accessCode, provided)) {
    throw new ForbiddenError('A valid access code is required to register.');
  }
}
