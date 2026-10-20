import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InventoryBundleService } from '../../application/inventory-bundle-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Sales bundles (FP-29 A7). Strict schemas; quantities are decimal strings. */

const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const itemParams = z.object({ itemId: fields.id }).strict();
const setBody = z
  .object({
    components: z
      .array(z.object({ itemId: fields.id, quantity }).strict())
      .min(1)
      .max(50),
  })
  .strict();

export function registerInventoryBundleRoutes(
  app: FastifyInstance,
  { inventoryBundles }: { inventoryBundles: InventoryBundleService },
) {
  app.get('/inventory/bundles', async (request) => ({
    data: await inventoryBundles.list(requirePrincipal(request)),
  }));
  app.get('/inventory/bundles/:itemId', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await inventoryBundles.get(principal, itemId) };
  });
  app.put('/inventory/bundles/:itemId', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    const body = parseInput(setBody, request.body);
    return { data: await inventoryBundles.set(principal, itemId, body, eventOrigin(request)) };
  });
  app.delete('/inventory/bundles/:itemId', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await inventoryBundles.remove(principal, itemId, eventOrigin(request)) };
  });
}
