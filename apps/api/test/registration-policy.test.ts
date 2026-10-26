import { describe, expect, it } from 'vitest';
import {
  assertRegistrationAllowed,
  REGISTRATION_ATTEMPTS_PER_MINUTE,
  registrationPolicyView,
  type RegistrationConfig,
} from '../src/application/registration-policy.js';
import { ForbiddenError } from '../src/domain/errors.js';
import { ConfigError, loadConfig } from '../src/infrastructure/config/config.js';

/**
 * Who may register (REGISTRATION_MODE): the pure policy and the configuration rules. No database.
 * The HTTP behaviour is in `registration-access.test.ts`.
 */

const CODE = 'review-access-code-1';
const open: RegistrationConfig = { mode: 'open', accessCode: undefined };
const closed: RegistrationConfig = { mode: 'closed', accessCode: undefined };
const coded: RegistrationConfig = { mode: 'code', accessCode: CODE };

describe('assertRegistrationAllowed', () => {
  it('lets anyone register in open mode, whatever code is sent', () => {
    expect(() => assertRegistrationAllowed(open, undefined)).not.toThrow();
    expect(() => assertRegistrationAllowed(open, 'anything')).not.toThrow();
  });

  it('refuses everyone in closed mode, even with a code', () => {
    expect(() => assertRegistrationAllowed(closed, undefined)).toThrow(ForbiddenError);
    expect(() => assertRegistrationAllowed(closed, CODE)).toThrow('Registration is closed.');
    expect(() => assertRegistrationAllowed({ ...closed, accessCode: CODE }, CODE)).toThrow(
      ForbiddenError,
    );
  });

  it('accepts only the exact code in code mode', () => {
    expect(() => assertRegistrationAllowed(coded, CODE)).not.toThrow();
    for (const wrong of [CODE.toUpperCase(), ` ${CODE}`, `${CODE} `, CODE.slice(0, -1), '', 'x']) {
      expect(() => assertRegistrationAllowed(coded, wrong), JSON.stringify(wrong)).toThrow(
        ForbiddenError,
      );
    }
  });

  it('answers a missing and a wrong code identically, and never repeats the code', () => {
    const message = (provided: string | undefined) => {
      try {
        assertRegistrationAllowed(coded, provided);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    expect(message(undefined)).toBe(message('wrong-code-value'));
    expect(message(undefined)).not.toBe('');
    expect(message('wrong-code-value')).not.toContain(CODE);
  });

  it('refuses in code mode when no code is configured (fails closed)', () => {
    expect(() =>
      assertRegistrationAllowed({ mode: 'code', accessCode: undefined }, 'whatever'),
    ).toThrow(ForbiddenError);
  });

  it('checks only the mode when asked to (used before the body is read)', () => {
    expect(() => assertRegistrationAllowed(closed, undefined, { checkCode: false })).toThrow(
      'Registration is closed.',
    );
    expect(() => assertRegistrationAllowed(coded, undefined, { checkCode: false })).not.toThrow();
    expect(() => assertRegistrationAllowed(open, undefined, { checkCode: false })).not.toThrow();
  });

  it('limits guessing to a small number of attempts per minute', () => {
    expect(REGISTRATION_ATTEMPTS_PER_MINUTE).toBeGreaterThanOrEqual(3);
    expect(REGISTRATION_ATTEMPTS_PER_MINUTE).toBeLessThanOrEqual(30);
  });
});

describe('registrationPolicyView', () => {
  it('exposes the mode and nothing else', () => {
    expect(registrationPolicyView(coded)).toEqual({ mode: 'code' });
    expect(JSON.stringify(registrationPolicyView(coded))).not.toContain(CODE);
    expect(registrationPolicyView(open)).toEqual({ mode: 'open' });
    expect(registrationPolicyView(closed)).toEqual({ mode: 'closed' });
  });
});

describe('registration configuration', () => {
  const env = {
    DATABASE_URL: 'postgres://intuit_app:x@localhost:5432/intuit2_unit',
    SESSION_SECRET: 'x'.repeat(48),
    MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    WEB_ORIGIN: 'http://localhost:5173',
    APP_ENV: 'testing',
  };

  it('defaults to open registration, which keeps the current behaviour', () => {
    expect(loadConfig(env).registration).toEqual({ mode: 'open', accessCode: undefined });
  });

  it('reads closed and code modes', () => {
    expect(loadConfig({ ...env, REGISTRATION_MODE: 'closed' }).registration.mode).toBe('closed');
    const config = loadConfig({
      ...env,
      REGISTRATION_MODE: 'code',
      REGISTRATION_ACCESS_CODE: CODE,
    });
    expect(config.registration).toEqual({ mode: 'code', accessCode: CODE });
  });

  it('refuses code mode without a code, naming the variable but no value', () => {
    expect(() => loadConfig({ ...env, REGISTRATION_MODE: 'code' })).toThrow(
      /REGISTRATION_ACCESS_CODE: required when REGISTRATION_MODE=code/,
    );
  });

  it('refuses a code that would not be enforced, and never echoes it', () => {
    for (const mode of [undefined, 'open', 'closed']) {
      let message = '';
      try {
        loadConfig({
          ...env,
          ...(mode ? { REGISTRATION_MODE: mode } : {}),
          REGISTRATION_ACCESS_CODE: CODE,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message, String(mode)).toContain('only used when REGISTRATION_MODE=code');
      expect(message).not.toContain(CODE);
    }
  });

  it('refuses a short code and an unknown mode', () => {
    expect(() =>
      loadConfig({ ...env, REGISTRATION_MODE: 'code', REGISTRATION_ACCESS_CODE: 'short' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, REGISTRATION_MODE: 'invite-only' })).toThrow(ConfigError);
  });
});
