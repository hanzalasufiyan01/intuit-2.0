import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth-service.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { fields, idParams, parseInput } from '../http/validation.js';
import {
  clearSessionCookie,
  csrfTokenFor,
  eventOrigin,
  requirePrincipal,
  setSessionCookie,
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

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; config: AppConfig },
): void {
  const { auth, config } = deps;

  /** Full session state for the web app, including the CSRF token for this session. */
  const sessionResponse = async (principal: Parameters<AuthService['getSessionView']>[0]) => ({
    data: {
      ...(await auth.getSessionView(principal)),
      csrfToken: csrfTokenFor(config, principal.session.id),
    },
  });

  app.post('/auth/register', async (request, reply) => {
    const body = parseInput(registerBody, request.body);
    if (request.principal) await auth.logout(request.principal, eventOrigin(request));
    const { issued } = await auth.register(body, eventOrigin(request));
    setSessionCookie(reply, config, issued.token, issued.session.expiresAt);
    const principal = await auth.authenticate(issued.token, eventOrigin(request));
    if (!principal) throw new Error('Newly issued session failed validation');
    return reply.status(201).send(await sessionResponse(principal));
  });

  app.post('/auth/login', async (request, reply) => {
    const body = parseInput(loginBody, request.body);
    if (request.principal) await auth.logout(request.principal, eventOrigin(request));
    const { issued } = await auth.login(body, eventOrigin(request));
    setSessionCookie(reply, config, issued.token, issued.session.expiresAt);
    const principal = await auth.authenticate(issued.token, eventOrigin(request));
    if (!principal) throw new Error('Newly issued session failed validation');
    return sessionResponse(principal);
  });

  app.post('/auth/logout', async (request, reply) => {
    const principal = requirePrincipal(request);
    await auth.logout(principal, eventOrigin(request));
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });

  app.get('/auth/session', async (request) => sessionResponse(requirePrincipal(request)));

  app.post('/auth/reauthenticate', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(reauthBody, request.body);
    const reauthenticatedAt = await auth.reauthenticate(
      principal,
      body.password,
      eventOrigin(request),
    );
    return sessionResponse({ ...principal, session: { ...principal.session, reauthenticatedAt } });
  });

  app.put('/auth/session/organization', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(switchOrganizationBody, request.body);
    await auth.switchOrganization(principal, body.organizationId, eventOrigin(request));
    return sessionResponse({
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
    if (request.principal) clearSessionCookie(reply, config);
    return { data: { message: 'Your password has been changed. Please sign in again.' } };
  });
}
