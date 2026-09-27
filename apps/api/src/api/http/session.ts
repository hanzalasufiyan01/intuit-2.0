import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../../application/auth-service.js';
import type { Principal } from '../../application/authorization.js';
import { AppError, UnauthenticatedError } from '../../domain/errors.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { constantTimeEqual, hmac } from '../../infrastructure/security/tokens.js';
import type { EventOrigin } from '../../modules/audit/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook when a valid, unrevoked, unexpired session cookie is present. */
    principal: Principal | null;
  }
}

export const CSRF_HEADER = 'x-csrf-token';
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
  if (!request.principal) throw new UnauthenticatedError();
  return request.principal;
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
      request.principal = await auth.authenticate(token, eventOrigin(request));
      if (!request.principal) clearSessionCookie(reply, config);
    }

    if (unsafe && request.principal) {
      const presented = request.headers[CSRF_HEADER];
      const expected = csrfTokenFor(config, request.principal.session.id);
      if (typeof presented !== 'string' || !constantTimeEqual(presented, expected)) {
        request.log.warn(
          { userId: request.principal.user.id },
          'Rejected request with invalid CSRF token',
        );
        throw new CsrfRejectedError();
      }
    }
  });
}
