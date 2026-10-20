import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleService } from '../../application/module-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { parseInput } from '../http/validation.js';

/** Optional module switches (FP-24). Reading needs organization.read; changing needs organization.update. */

const params = z.object({ key: z.string().min(1).max(30) }).strict();
const body = z.object({ enabled: z.boolean() }).strict();

export function registerModuleRoutes(
  app: FastifyInstance,
  { modules }: { modules: ModuleService },
) {
  app.get('/organizations/current/modules', async (request) => ({
    data: await modules.list(requirePrincipal(request)),
  }));
  app.put('/organizations/current/modules/:key', async (request) => {
    const { key } = parseInput(params, request.params);
    const { enabled } = parseInput(body, request.body);
    return {
      data: await modules.set(requirePrincipal(request), key, enabled, eventOrigin(request)),
    };
  });
}
