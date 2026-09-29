import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService, LoginResult } from '../../application/auth-service.js';
import type { Principal } from '../../application/authorization.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { fields, idParams, parseInput } from '../http/validation.js';
import {
  clearSessionCookie,
  clearTrustedDeviceCookie,
  csrfTokenFor,
  eventOrigin,
  requirePrincipal,
  setSessionCookie,
  setTrustedDeviceCookie,
  trustedDeviceToken,
} from '../http/session.js';

const registerBody = z.object({
  email: fields.email,
  password: fields.password,
  displayName: fields.displayName,
  organizationName: fields.organizationName,
});
const loginBody = z.object({ email: fields.email, password: fields.password });
const reauthBody = z.object({ password: fields.password });
const resetRequestBody = z.object({ email: fields.email });
const resetCompleteBody = z.object({ token: fields.token, newPassword: fields.password });
const switchOrganizationBody = z.object({ organizationId: fields.id });

/** Full session state for the web app, including the CSRF token for this session. */
export async function sessionResponse(auth: AuthService, config: AppConfig, principal: Principal) {
  return {
    data: {
      ...(await auth.getSessionView(principal)),
      csrfToken: csrfTokenFor(config, principal.session.id),
    },
  };
}

/** What a waiting-for-MFA session may see (S7-15): the challenge screen only. */
export function pendingSessionResponse(auth: AuthService, config: AppConfig, principal: Principal) {
  return {
    data: {
      ...auth.pendingSessionView(principal),
      csrfToken: csrfTokenFor(config, principal.session.id),
    },
  };
}

/** Ends whatever session (complete or MFA-pending) the request carries. */
async function endCurrentSession(request: FastifyRequest, auth: AuthService) {
  const current = request.principal ?? request.pendingPrincipal;
  if (current) await auth.logout(current, eventOrigin(request));
}

function applyDeviceCookie(reply: FastifyReply, config: AppConfig, device: LoginResult['device']) {
  if (device === 'clear') clearTrustedDeviceCookie(reply, config);
  else if (device) setTrustedDeviceCookie(reply, config, device.token, device.expiresAt);
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; config: AppConfig },
): void {
  const { auth, config } = deps;

  app.post('/auth/register', async (request, reply) => {
    const body = parseInput(registerBody, request.body);
    await endCurrentSession(request, auth);
    const { issued } = await auth.register(body, eventOrigin(request));
    setSessionCookie(reply, config, issued.token, issued.session.expiresAt);
    const principal = await auth.authenticate(issued.token, eventOrigin(request));
    if (!principal) throw new Error('Newly issued session failed validation');
    return reply.status(201).send(await sessionResponse(auth, config, principal));
  });

  /** A user with MFA gets an MFA-pending session unless a remembered device is presented. */
  app.post('/auth/login', async (request, reply) => {
    const body = parseInput(loginBody, request.body);
    await endCurrentSession(request, auth);
    const result = await auth.login(
      body,
      eventOrigin(request),
      trustedDeviceToken(request, config),
    );
    setSessionCookie(reply, config, result.issued.token, result.issued.session.expiresAt);
    applyDeviceCookie(reply, config, result.device);
    const principal = await auth.authenticate(result.issued.token, eventOrigin(request));
    if (!principal) throw new Error('Newly issued session failed validation');
    return result.mfaPending
      ? pendingSessionResponse(auth, config, principal)
      : sessionResponse(auth, config, principal);
  });

  app.post('/auth/logout', async (request, reply) => {
    const principal = request.principal ?? request.pendingPrincipal;
    if (!principal) requirePrincipal(request);
    await endCurrentSession(request, auth);
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });

  app.get('/auth/session', async (request) =>
    request.pendingPrincipal && !request.principal
      ? pendingSessionResponse(auth, config, request.pendingPrincipal)
      : sessionResponse(auth, config, requirePrincipal(request)),
  );

  app.post('/auth/reauthenticate', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(reauthBody, request.body);
    const reauthenticatedAt = await auth.reauthenticate(
      principal,
      body.password,
      eventOrigin(request),
    );
    return sessionResponse(auth, config, {
      ...principal,
      session: { ...principal.session, reauthenticatedAt },
    });
  });

  app.put('/auth/session/organization', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(switchOrganizationBody, request.body);
    await auth.switchOrganization(principal, body.organizationId, eventOrigin(request));
    return sessionResponse(auth, config, {
      ...principal,
      session: { ...principal.session, activeOrganizationId: body.organizationId },
    });
  });

  app.get('/auth/sessions', async (request) => ({
    data: await auth.listSessions(requirePrincipal(request)),
  }));

  /** Revoking the current session is a logout; revoking another session is sensitive. */
  app.delete('/auth/sessions/:sessionId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { sessionId } = parseInput(idParams('sessionId'), request.params) as {
      sessionId: string;
    };
    if (sessionId === principal.session.id) {
      await auth.logout(principal, eventOrigin(request));
      clearSessionCookie(reply, config);
    } else {
      await auth.revokeOtherSession(principal, sessionId, eventOrigin(request));
    }
    return reply.status(204).send();
  });

  /** Identical response for known and unknown emails (no account enumeration). */
  app.post('/auth/password-reset/request', async (request, reply) => {
    const body = parseInput(resetRequestBody, request.body);
    await auth.requestPasswordReset(body.email, eventOrigin(request));
    return reply.status(202).send({
      data: { message: 'If an account exists for this email, a reset link has been sent.' },
    });
  });

  app.post('/auth/password-reset/complete', async (request, reply) => {
    const body = parseInput(resetCompleteBody, request.body);
    await auth.completePasswordReset(body, eventOrigin(request));
    if (request.principal || request.pendingPrincipal) clearSessionCookie(reply, config);
    return { data: { message: 'Your password has been changed. Please sign in again.' } };
  });
}
