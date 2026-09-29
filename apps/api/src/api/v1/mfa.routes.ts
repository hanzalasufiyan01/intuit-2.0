import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth-service.js';
import type { MfaService } from '../../application/mfa-service.js';
import { UnauthenticatedError } from '../../domain/errors.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import {
  clearTrustedDeviceCookie,
  eventOrigin,
  requirePendingPrincipal,
  requirePrincipal,
  setSessionCookie,
  setTrustedDeviceCookie,
  trustedDeviceToken,
} from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';
import { sessionResponse } from './auth.routes.js';

const method = z.enum(['totp', 'recovery_code']);
// Codes are short; the cap only bounds work before the (generic) rejection.
const code = z.string().trim().min(1, 'Enter a code.').max(64);
const challengeBody = z
  .object({ method, code, rememberDevice: z.boolean().default(false) })
  .strict();
const stepUpBody = z.object({ method, code }).strict();
const verifyBody = z.object({ enrollmentId: fields.id, code }).strict();
const disableBody = z.object({ factorId: fields.id }).strict();
const emptyBody = z.object({}).strict();
const deviceParams = z.object({ deviceId: fields.id }).strict();

/**
 * MFA API (S7-41). The challenge is the only route an MFA-pending session can use (besides the
 * session read and logout). Responses carrying secrets or codes are `no-store` (the global
 * default) and are the only time those values are ever returned.
 */
export function registerMfaRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; mfa: MfaService; config: AppConfig },
): void {
  const { auth, mfa, config } = deps;

  /** Re-reads the session after its token was rotated and returns the full session view. */
  const rotated = async (request: FastifyRequest, reply: FastifyReply, token: string) => {
    const principal = await auth.authenticate(token, eventOrigin(request));
    if (!principal) throw new UnauthenticatedError();
    const response = await sessionResponse(auth, config, principal);
    setSessionCookie(reply, config, token, principal.session.expiresAt);
    return response;
  };

  app.post('/auth/mfa/challenge', async (request, reply) => {
    const principal = requirePendingPrincipal(request);
    const body = parseInput(challengeBody, request.body);
    const result = await auth.completeMfaChallenge(principal, body, eventOrigin(request));
    if (result.device) {
      setTrustedDeviceCookie(reply, config, result.device.token, result.device.expiresAt);
    }
    return rotated(request, reply, result.token);
  });

  app.get('/auth/mfa', async (request) => ({
    data: await mfa.status(requirePrincipal(request)),
  }));

  app.post('/auth/mfa/totp/enroll', async (request) => {
    const principal = requirePrincipal(request);
    parseInput(emptyBody, request.body);
    return { data: await mfa.startEnrollment(principal, eventOrigin(request)) };
  });

  app.post('/auth/mfa/totp/verify', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(verifyBody, request.body);
    const result = await mfa.completeEnrollment(principal, body, eventOrigin(request));
    const session = await rotated(request, reply, result.sessionToken);
    return { data: { recoveryCodes: result.recoveryCodes, session: session.data } };
  });

  app.post('/auth/mfa/totp/disable', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(disableBody, request.body);
    await mfa.disable(principal, body, eventOrigin(request));
    clearTrustedDeviceCookie(reply, config);
    return reply.status(204).send();
  });

  app.post('/auth/mfa/step-up', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(stepUpBody, request.body);
    const token = await mfa.stepUp(principal, body, eventOrigin(request));
    return rotated(request, reply, token);
  });

  app.post('/auth/mfa/recovery-codes', async (request) => {
    const principal = requirePrincipal(request);
    parseInput(emptyBody, request.body);
    return {
      data: { recoveryCodes: await mfa.regenerateRecoveryCodes(principal, eventOrigin(request)) },
    };
  });

  app.get('/auth/trusted-devices', async (request) => ({
    data: await mfa.listTrustedDevices(
      requirePrincipal(request),
      trustedDeviceToken(request, config),
    ),
  }));

  app.delete('/auth/trusted-devices/:deviceId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { deviceId } = parseInput(deviceParams, request.params);
    const devices = await mfa.listTrustedDevices(principal, trustedDeviceToken(request, config));
    await mfa.revokeTrustedDevice(principal, deviceId, eventOrigin(request));
    if (devices.some((d) => d.id === deviceId && d.current))
      clearTrustedDeviceCookie(reply, config);
    return reply.status(204).send();
  });

  app.delete('/auth/trusted-devices', async (request, reply) => {
    const principal = requirePrincipal(request);
    const revoked = await mfa.revokeAllTrustedDevices(principal, eventOrigin(request));
    clearTrustedDeviceCookie(reply, config);
    return { data: { revoked } };
  });
}
