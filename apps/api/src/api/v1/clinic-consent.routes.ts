import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClinicConsentService } from '../../application/clinic-consent-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Clinic consent register and retention review (migration 0086, ADR 0013 addendum). Strict
 * schemas. The wording is the organization's own text; nothing here is legal advice.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const idParams = z.object({ id: fields.id }).strict();
const consentBody = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    wording: z.string().trim().max(4000).optional(),
    action: z.enum(['granted', 'withdrawn']),
    effectiveDate: isoDate.optional(),
  })
  .strict();
const settingsBody = z
  .object({
    retentionYears: z.number().int().min(1).max(100).nullable(),
    version: z.number().int().min(0),
  })
  .strict();

export function registerClinicConsentRoutes(
  app: FastifyInstance,
  { clinicConsent }: { clinicConsent: ClinicConsentService },
) {
  app.get('/clinic/patients/:id/consents', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await clinicConsent.list(principal, id, eventOrigin(request)) };
  });
  app.post('/clinic/patients/:id/consents', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(consentBody, request.body);
    return reply
      .status(201)
      .send({ data: await clinicConsent.record(principal, id, input, eventOrigin(request)) });
  });
  app.get('/clinic/settings', async (request) => ({
    data: await clinicConsent.getSettings(requirePrincipal(request)),
  }));
  app.put('/clinic/settings', async (request) => {
    const principal = requirePrincipal(request);
    const input = parseInput(settingsBody, request.body);
    return { data: await clinicConsent.setSettings(principal, input, eventOrigin(request)) };
  });
  app.get('/clinic/retention-review', async (request) => ({
    data: await clinicConsent.retentionReview(requirePrincipal(request), eventOrigin(request)),
  }));
}
