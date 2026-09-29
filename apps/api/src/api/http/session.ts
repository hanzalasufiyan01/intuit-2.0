import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../../application/auth-service.js';
import type { Principal } from '../../application/authorization.js';
import { AppError, MfaRequiredError, UnauthenticatedError } from '../../domain/errors.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { constantTimeEqual, hmac } from '../../infrastructure/security/tokens.js';
import type { EventOrigin } from '../../modules/audit/index.js';
import { isMfaPending } from '../../modules/identity/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the session hook when a valid, unrevoked, unexpired session cookie is present and
     * the session is not waiting for its second factor.
     */
    principal: Principal | null;
    /**
     * An MFA-pending session (S7-15). Deliberately separate from `principal`, so every route is
     * closed to it by default; only the challenge, session read and logout routes look here.
     */
    pendingPrincipal: Principal | null;
  }
}

export const CSRF_HEADER = 'x-csrf-token';

/** The only routes an MFA-pending session may use (default-deny, S7-15). */
const PENDING_MFA_ROUTES = new Set([
  'POST /api/v1/auth/mfa/challenge',
  'GET /api/v1/auth/session',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/register',
]);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class CsrfRejectedError extends AppError {
  constructor() {
    super(
      'CSRF_REJECTED',
      403,
      'The request could not be verified. Refresh the page and try again.',
    );
  }
}

/** CSRF token bound to one session (HMAC of the session id with the server secret). */
export function csrfTokenFor(config: AppConfig, sessionId: string): string {
  return hmac(config.session.secret, `csrf:${sessionId}`);
}

export function eventOrigin(request: FastifyRequest): EventOrigin {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ipAddress: request.ip || null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    if (request.pendingPrincipal) throw new MfaRequiredError();
    throw new UnauthenticatedError();
  }
  return request.principal;
}

/** The MFA-pending session, for the routes that complete or end it. */
export function requirePendingPrincipal(request: FastifyRequest): Principal {
  if (!request.pendingPrincipal) throw new UnauthenticatedError();
  return request.pendingPrincipal;
}

/** Remembered-device cookie (S7-34): httpOnly, SameSite=Strict, sent only to /api/v1/auth. */
const TRUSTED_DEVICE_COOKIE_PATH = '/api/v1/auth';

export function setTrustedDeviceCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(config.mfa.trustedDeviceCookieName, token, {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'strict',
    path: TRUSTED_DEVICE_COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearTrustedDeviceCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(config.mfa.trustedDeviceCookieName, {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'strict',
    path: TRUSTED_DEVICE_COOKIE_PATH,
  });
}

export function trustedDeviceToken(request: FastifyRequest, config: AppConfig): string | undefined {
  const value = request.cookies[config.mfa.trustedDeviceCookieName];
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(config.session.cookieName, token, {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(config.session.cookieName, {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Request security hook, for every request:
 * 1. State-changing requests must come from the web origin (Origin / Fetch Metadata check).
 * 2. The opaque session cookie is validated against PostgreSQL (revocation is immediate).
 * 3. Cookie-authenticated state-changing requests must carry the session's CSRF token.
 */
export function registerSessionSecurity(
  app: FastifyInstance,
  deps: { config: AppConfig; auth: AuthService },
): void {
  const { config, auth } = deps;
  app.decorateRequest('principal', null);
  app.decorateRequest('pendingPrincipal', null);

  app.addHook('onRequest', async (request, reply) => {
    const unsafe = UNSAFE_METHODS.has(request.method);

    if (unsafe) {
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== config.webOrigin) || fetchSite === 'cross-site') {
        request.log.warn({ origin, fetchSite }, 'Rejected cross-origin state-changing request');
        throw new CsrfRejectedError();
      }
    }

    const token = request.cookies[config.session.cookieName];
    if (token) {
      const authenticated = await auth.authenticate(token, eventOrigin(request));
      if (!authenticated) clearSessionCookie(reply, config);
      else if (isMfaPending(authenticated.session)) request.pendingPrincipal = authenticated;
      else request.principal = authenticated;
    }

    // S7-15: an MFA-pending session reaches only the challenge, the session read, logout and a
    // fresh sign-in / registration. Everything else is refused here, before any handler runs.
    if (request.pendingPrincipal) {
      const route = `${request.method} ${request.routeOptions.url ?? ''}`;
      if (!PENDING_MFA_ROUTES.has(route)) throw new MfaRequiredError();
    }

    // Pending sessions carry a CSRF token too (the challenge is a state-changing request).
    const csrfSubject = request.principal ?? request.pendingPrincipal;
    if (unsafe && csrfSubject) {
      const presented = request.headers[CSRF_HEADER];
      const expected = csrfTokenFor(config, csrfSubject.session.id);
      if (typeof presented !== 'string' || !constantTimeEqual(presented, expected)) {
        request.log.warn(
          { userId: csrfSubject.user.id },
          'Rejected request with invalid CSRF token',
        );
        throw new CsrfRejectedError();
      }
    }
  });
}
