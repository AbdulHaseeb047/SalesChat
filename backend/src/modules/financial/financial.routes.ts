import { Router } from 'express';

import { FEATURES } from '../../constants/index.js';
import { jsonHandler } from '../../middleware/async-handler.js';
import { ValidationError } from '../core/errors.js';
import { resolveTenantId } from '../core/tenant.js';
import { authenticate, requireFeature } from '../permissions/permissions.middleware.js';
import {
  createFinancialEntry,
  financialEntrySchema,
  getFinancialSummary,
  listFinancialEntries,
  voidFinancialEntry,
} from './financial.service.js';

export function createFinancialRouter(): Router {
  const router = Router();
  const view = requireFeature(FEATURES.REPORTS_VIEW);

  router.get(
    '/financial/entries',
    authenticate,
    view,
    jsonHandler(async (req) => {
      const q = req.query as { from?: string; to?: string };
      return listFinancialEntries(resolveTenantId(req), q.from, q.to);
    }),
  );

  router.get(
    '/financial/summary',
    authenticate,
    view,
    jsonHandler(async (req) => {
      const q = req.query as { from?: string; to?: string };
      return getFinancialSummary(resolveTenantId(req), q.from, q.to);
    }),
  );

  router.post(
    '/financial/entries',
    authenticate,
    view,
    jsonHandler(async (req) => {
      const parsed = financialEntrySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid financial entry', parsed.error.flatten());
      return createFinancialEntry(resolveTenantId(req), req.user!.id, parsed.data);
    }),
  );

  router.post(
    '/financial/entries/:id/void',
    authenticate,
    view,
    jsonHandler(async (req) => {
      const body = req.body as { reason?: string };
      if (!body.reason?.trim()) throw new ValidationError('Void reason is required');
      return voidFinancialEntry(resolveTenantId(req), req.params.id, body.reason);
    }),
  );

  return router;
}
