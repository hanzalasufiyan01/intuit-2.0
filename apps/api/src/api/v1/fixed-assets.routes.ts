import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FixedAssetService } from '../../application/fixed-asset-service.js';
import { depreciationMethods } from '../../modules/fixed-assets/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Fixed assets (strict schemas; decimals as strings; depreciation computed by the server).
 * Viewing needs `fixed_assets.view`; registering, depreciating, disposing and voiding have their
 * own permissions. Voiding a run or a disposal also needs a recent password confirmation.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
// An annual percentage (R-11): the service checks greater than 0 and at most 100.
const rate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a rate with up to 4 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const versionBody = z.object({ version }).strict();
const voidBody = z
  .object({ version, reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();

const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    costAccountId: fields.id,
    accumulatedAccountId: fields.id,
    expenseAccountId: fields.id,
    defaultLifeMonths: z.number().int().min(1).max(1200),
  })
  .strict();
const categoryUpdateBody = z
  .object({
    version,
    name: z.string().trim().min(1).max(100).optional(),
    costAccountId: fields.id.optional(),
    accumulatedAccountId: fields.id.optional(),
    expenseAccountId: fields.id.optional(),
    defaultLifeMonths: z.number().int().min(1).max(1200).optional(),
  })
  .strict();
const settingsBody = z
  .object({ version: z.number().int().min(0), gainLossAccountId: fields.id.nullable() })
  .strict();
const assetBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    categoryId: fields.id,
    acquisitionDate: isoDate,
    inServiceDate: isoDate.optional(),
    cost: amount,
    salvageValue: amount.optional(),
    lifeMonths: z.number().int().min(1).max(1200).optional(),
    depreciationMethod: z.enum(depreciationMethods).optional(),
    decliningRate: rate.optional(),
    creditAccountId: fields.id.optional(),
    alreadyInLedger: z.boolean().optional(),
    sourceBillId: fields.id.optional(),
    duplicateOverrideReason: z.string().trim().min(3).max(500).optional(),
    location: z.string().trim().max(200).optional(),
    custodian: z.string().trim().max(200).optional(),
    serialNumber: z.string().trim().max(100).optional(),
  })
  .strict();
// The schedule an asset would get, before registering it (nothing is saved).
const schedulePreviewBody = assetBody
  .pick({
    categoryId: true,
    acquisitionDate: true,
    inServiceDate: true,
    cost: true,
    salvageValue: true,
    lifeMonths: true,
    depreciationMethod: true,
    decliningRate: true,
  })
  .strict();
const assetUpdateBody = z
  .object({
    version,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    custodian: z.string().trim().max(200).optional(),
    serialNumber: z.string().trim().max(100).optional(),
  })
  .strict();
const transferBody = z
  .object({
    version,
    transferDate: isoDate,
    toCategoryId: fields.id.optional(),
    toLocation: z.string().trim().max(200).optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();
const disposeBody = z
  .object({
    version,
    disposalDate: isoDate,
    proceeds: amount.optional(),
    proceedsAccountId: fields.id.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();
const runBody = z.object({ monthEnd: isoDate }).strict();
const listQuery = z
  .object({
    status: z.enum(['ACTIVE', 'DISPOSED']).optional(),
    categoryId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const asOfQuery = z.object({ asOf: isoDate }).strict();
const monthQuery = z.object({ monthEnd: isoDate }).strict();
const limitQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
const disposalsQuery = z.object({ assetId: fields.id.optional() }).strict();

export function registerFixedAssetRoutes(
  app: FastifyInstance,
  { fixedAssets }: { fixedAssets: FixedAssetService },
) {
  app.get('/fixed-assets/settings', async (request) => ({
    data: await fixedAssets.getSettings(requirePrincipal(request)),
  }));
  app.put('/fixed-assets/settings', async (request) => {
    const body = parseInput(settingsBody, request.body);
    return {
      data: await fixedAssets.updateSettings(requirePrincipal(request), body, eventOrigin(request)),
    };
  });

  app.get('/fixed-assets/categories', async (request) => ({
    data: await fixedAssets.listCategories(requirePrincipal(request)),
  }));
  app.post('/fixed-assets/categories', async (request, reply) => {
    const body = parseInput(categoryBody, request.body);
    const data = await fixedAssets.createCategory(
      requirePrincipal(request),
      body,
      eventOrigin(request),
    );
    return reply.status(201).send({ data });
  });
  app.patch('/fixed-assets/categories/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(categoryUpdateBody, request.body);
    return {
      data: await fixedAssets.updateCategory(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
  for (const [path, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/fixed-assets/categories/:id/${path}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await fixedAssets.setCategoryStatus(
          requirePrincipal(request),
          id,
          status,
          body,
          eventOrigin(request),
        ),
      };
    });
  }

  app.get('/fixed-assets/assets', async (request) => ({
    data: await fixedAssets.listAssets(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/fixed-assets/assets', async (request, reply) => {
    const body = parseInput(assetBody, request.body);
    const result = await fixedAssets.createAsset(
      requirePrincipal(request),
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.post('/fixed-assets/assets/schedule-preview', async (request) => {
    const body = parseInput(schedulePreviewBody, request.body);
    return { data: await fixedAssets.previewSchedule(requirePrincipal(request), body) };
  });
  app.get('/fixed-assets/assets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await fixedAssets.getAsset(requirePrincipal(request), id) };
  });
  app.patch('/fixed-assets/assets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(assetUpdateBody, request.body);
    return {
      data: await fixedAssets.updateAsset(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
  app.post('/fixed-assets/assets/:id/transfer', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(transferBody, request.body);
    return {
      data: await fixedAssets.transferAsset(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
  app.post('/fixed-assets/assets/:id/dispose', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(disposeBody, request.body);
    const result = await fixedAssets.disposeAsset(
      requirePrincipal(request),
      id,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/fixed-assets/disposals', async (request) => {
    const query = parseInput(disposalsQuery, request.query);
    return {
      data: await fixedAssets.listDisposals(requirePrincipal(request), query.assetId ?? null),
    };
  });
  app.post('/fixed-assets/disposals/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return {
      data: await fixedAssets.voidDisposal(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });

  app.get('/fixed-assets/depreciation/preview', async (request) => {
    const { monthEnd } = parseInput(monthQuery, request.query);
    return { data: await fixedAssets.previewDepreciation(requirePrincipal(request), monthEnd) };
  });
  app.get('/fixed-assets/depreciation/runs', async (request) => {
    const { limit } = parseInput(limitQuery, request.query);
    return { data: await fixedAssets.listRuns(requirePrincipal(request), limit) };
  });
  app.post('/fixed-assets/depreciation/runs', async (request, reply) => {
    const body = parseInput(runBody, request.body);
    const result = await fixedAssets.runDepreciation(
      requirePrincipal(request),
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/fixed-assets/depreciation/runs/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await fixedAssets.getRun(requirePrincipal(request), id) };
  });
  app.post('/fixed-assets/depreciation/runs/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return {
      data: await fixedAssets.voidRun(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });

  app.get('/fixed-assets/reports/register', async (request) => {
    const { asOf } = parseInput(asOfQuery, request.query);
    return { data: await fixedAssets.register(requirePrincipal(request), asOf) };
  });
  app.get('/fixed-assets/reports/reconciliation', async (request) => {
    const { asOf } = parseInput(asOfQuery, request.query);
    return { data: await fixedAssets.reconciliation(requirePrincipal(request), asOf) };
  });
}
