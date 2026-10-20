import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClinicService } from '../../application/clinic-service.js';
import { appointmentStatuses, sexValues } from '../../modules/clinic/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Clinic extension (FP-27, ADR 0013). Strict schemas. The module must be enabled for the
 * organization; the permissions are owner/administrator by default. Patient reads are audited by
 * the service. There is deliberately no clinical-content field anywhere in these schemas.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const dateTime = z.string().min(10).max(40);
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const versionBody = z.object({ version }).strict();

const patientBody = {
  displayName: z.string().trim().min(1).max(200),
  dateOfBirth: isoDate.nullable().optional(),
  sex: z.enum(sexValues).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(320).nullable().optional(),
  nationalId: z.string().trim().max(40).nullable().optional(),
  billingCustomerId: fields.id.nullable().optional(),
};
const patientCreate = z.object(patientBody).strict();
const patientUpdate = z.object({ version, ...patientBody }).strict();
const patientList = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const serviceBody = {
  name: z.string().trim().min(1).max(150),
  price: amount,
  durationMinutes: z.number().int().min(5).max(480),
  salesItemId: fields.id.nullable().optional(),
};
const serviceCreate = z.object(serviceBody).strict();
const serviceUpdate = z.object({ version, isActive: z.boolean(), ...serviceBody }).strict();

const practitionerCreate = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    specialty: z.string().trim().max(100).optional(),
  })
  .strict();
const practitionerUpdate = z
  .object({
    version,
    isActive: z.boolean(),
    displayName: z.string().trim().min(1).max(200),
    specialty: z.string().trim().max(100).optional(),
  })
  .strict();

const bookBody = z
  .object({
    patientId: fields.id,
    practitionerId: fields.id,
    serviceId: fields.id,
    startsAt: dateTime,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const appointmentList = z
  .object({
    from: dateTime.optional(),
    to: dateTime.optional(),
    practitionerId: fields.id.optional(),
    patientId: fields.id.optional(),
    status: z.enum(appointmentStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
const cancelBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const moveBody = z
  .object({ version, startsAt: dateTime, practitionerId: fields.id.optional() })
  .strict();
const billBody = z
  .object({ version, customerId: fields.id.optional(), invoiceDate: isoDate.optional() })
  .strict();
const reportQuery = z.object({ from: isoDate, to: isoDate }).strict();

export function registerClinicRoutes(app: FastifyInstance, { clinic }: { clinic: ClinicService }) {
  app.get('/clinic/patients', async (request) => {
    const principal = requirePrincipal(request);
    return {
      data: await clinic.listPatients(
        principal,
        parseInput(patientList, request.query),
        eventOrigin(request),
      ),
    };
  });
  app.post('/clinic/patients', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await clinic.createPatient(
        principal,
        parseInput(patientCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.get('/clinic/patients/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await clinic.getPatient(principal, id, eventOrigin(request)) };
  });
  app.put('/clinic/patients/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.updatePatient(
        principal,
        id,
        parseInput(patientUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/clinic/patients/:id/anonymize', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.anonymizePatient(
        principal,
        id,
        parseInput(versionBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/clinic/services', async (request) => ({
    data: await clinic.listServices(requirePrincipal(request)),
  }));
  app.post('/clinic/services', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await clinic.createService(
        principal,
        parseInput(serviceCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.put('/clinic/services/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.updateService(
        principal,
        id,
        parseInput(serviceUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/clinic/practitioners', async (request) => ({
    data: await clinic.listPractitioners(requirePrincipal(request)),
  }));
  app.post('/clinic/practitioners', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await clinic.createPractitioner(
        principal,
        parseInput(practitionerCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.put('/clinic/practitioners/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.updatePractitioner(
        principal,
        id,
        parseInput(practitionerUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/clinic/appointments', async (request) => ({
    data: await clinic.listAppointments(
      requirePrincipal(request),
      parseInput(appointmentList, request.query),
    ),
  }));
  app.post('/clinic/appointments', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await clinic.bookAppointment(
        principal,
        parseInput(bookBody, request.body),
        eventOrigin(request),
      ),
    });
  });
  for (const [action, method] of [
    ['check-in', 'checkIn'],
    ['complete', 'complete'],
    ['no-show', 'noShow'],
  ] as const) {
    app.post(`/clinic/appointments/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      return {
        data: await clinic[method](
          principal,
          id,
          parseInput(versionBody, request.body),
          eventOrigin(request),
        ),
      };
    });
  }
  app.post('/clinic/appointments/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.cancel(
        principal,
        id,
        parseInput(cancelBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/clinic/appointments/:id/reschedule', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.reschedule(
        principal,
        id,
        parseInput(moveBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/clinic/appointments/:id/bill', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await clinic.bill(
        principal,
        id,
        parseInput(billBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/clinic/reports', async (request) => {
    const principal = requirePrincipal(request);
    return { data: await clinic.reports(principal, parseInput(reportQuery, request.query)) };
  });
}
