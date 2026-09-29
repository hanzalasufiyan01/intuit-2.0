import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobService } from '../../application/job-service.js';
import { requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

const jobParams = z.object({ id: fields.id }).strict();

/** Job status (S5-16): the creator or a holder of the job's required permission. */
export function registerJobRoutes(app: FastifyInstance, deps: { jobs: JobService }): void {
  app.get('/jobs/:id', async (request) => {
    const { id } = parseInput(jobParams, request.params);
    return { data: await deps.jobs.get(requirePrincipal(request), id) };
  });
}
