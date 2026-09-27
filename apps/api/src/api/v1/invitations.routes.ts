import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth-service.js';
import type { InvitationService } from '../../application/invitation-service.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { csrfTokenFor, eventOrigin, setSessionCookie } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

const lookupBody = z.object({ token: fields.token });
const acceptBody = z.object({
  token: fields.token,
  displayName: fields.displayName.optional(),
  password: fields.password.optional(),
});

/** Public invitation endpoints. Tokens travel in request bodies, never in URLs. */
export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: { invitations: InvitationService; auth: AuthService; config: AppConfig },
): void {
  const { invitations, auth, config } = deps;

  app.post('/invitations/lookup', async (request) => {
    const body = parseInput(lookupBody, request.body);
    return { data: await invitations.lookup(body.token) };
  });

  app.post('/invitations/accept', async (request, reply) => {
    const body = parseInput(acceptBody, request.body);
    const result = await invitations.accept(body, request.principal, eventOrigin(request));

    let principal = request.principal;
    if (result.issued) {
      setSessionCookie(reply, config, result.issued.token, result.issued.session.expiresAt);
      principal = await auth.authenticate(result.issued.token, eventOrigin(request));
    } else if (principal) {
      principal = {
        ...principal,
        session: { ...principal.session, activeOrganizationId: result.organizationId },
      };
    }
    if (!principal) throw new Error('Session missing after invitation acceptance');
    return {
      data: {
        ...(await auth.getSessionView(principal)),
        csrfToken: csrfTokenFor(config, principal.session.id),
      },
    };
  });
}
