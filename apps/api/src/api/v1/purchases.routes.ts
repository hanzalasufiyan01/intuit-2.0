import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PurchasesSettingsService } from '../../application/purchases-settings-service.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Purchases settings and numbering (Phase 4A-4; ADR 0004 P4-07, P4-51). Strict schemas. */

const numberingShape = z
  .object({
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9/_.#-]{0,12}$/, 'Use up to 12 letters, digits or / _ . # -.'),
    minDigits: z.number().int().min(1).max(10),
    nextNumber: z.number().int().min(1).max(999_999_999_999),
  })
  .strict();

const settingsBody = z
  .object({
    version: z.number().int().min(0),
    apAccountId: fields.id.nullable(),
    defaultExpenseAccountId: fields.id.nullable(),
    defaultPaymentAccountId: fields.id.nullable(),
    defaultTaxCodeId: fields.id.nullable(),
    defaultTaxTreatment: z.enum(taxTreatments),
    defaultPaymentTermsDays: z.number().int().min(0).max(365),
    numbering: z
      .object({
        bill: numberingShape.optional(),
        vendor_credit: numberingShape.optional(),
        debit_note: numberingShape.optional(),
        vendor_payment: numberingShape.optional(),
        vendor_refund: numberingShape.optional(),
        expense: numberingShape.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function registerPurchasesRoutes(
  app: FastifyInstance,
  { purchasesSettings }: { purchasesSettings: PurchasesSettingsService },
) {
  app.get('/purchases/settings', async (request) => ({
    data: await purchasesSettings.get(requirePrincipal(request)),
  }));
  app.put('/purchases/settings', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(settingsBody, request.body);
    return { data: await purchasesSettings.update(principal, body, eventOrigin(request)) };
  });
}
