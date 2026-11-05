import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { appConfig } from './config.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { globalRateLimit } from './middleware/rate-limits.js';
import { requestContext } from './middleware/request-context.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createBillingRouter } from './modules/billing/billing.routes.js';
import { createBranchRouter } from './modules/branches/branches.routes.js';
import { createCatalogRouter } from './modules/catalog/catalog.routes.js';
import { prisma } from './modules/core/prisma.js';
import { createCustomerRouter } from './modules/customers/customers.routes.js';
import { createInventoryRouter } from './modules/inventory/inventory.routes.js';
import { createFinancialRouter } from './modules/financial/financial.routes.js';
import { createPermissionRouter } from './modules/permissions/permissions.routes.js';
import { createReportRouter } from './modules/reports/reports.routes.js';
import { createSettingsRouter } from './modules/settings/settings.routes.js';
import { createSupportRouter } from './modules/support/support.routes.js';
import { createSyncRouter } from './modules/sync/sync.routes.js';
import { createTenantRouter } from './modules/tenants/tenants.routes.js';
import { createUserRouter } from './modules/users/users.routes.js';

export function createApp(): Express {
  const app = express();

  if (appConfig.trustProxy) {
    app.set('trust proxy', 1);
    logger.info('Trust proxy enabled');
  }

  app.use(
    helmet({
      contentSecurityPolicy: appConfig.nodeEnv === 'production',
    }),
  );
  app.use(cookieParser());
  app.use(
    cors({
      origin: appConfig.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: appConfig.nodeEnv === 'production',
    }),
  );
  app.use(globalRateLimit);
  app.use(requestContext);

  app.get('/health', async (_req, res, next) => {
    try {
      let database: 'connected' | 'disconnected' = 'disconnected';
      try {
        await prisma.$queryRaw`SELECT 1`;
        database = 'connected';
      } catch {
        database = 'disconnected';
      }

      res.status(database === 'connected' ? 200 : 503).json({
        status: database === 'connected' ? ('ok' as const) : ('degraded' as const),
        timestamp: new Date().toISOString(),
        database,
        deploymentMode: appConfig.deploymentMode,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(createAuthRouter());
  app.use(createPermissionRouter());
  app.use(createTenantRouter());
  app.use(createAdminRouter());
  app.use(createUserRouter());
  app.use(createInventoryRouter());
  app.use(createFinancialRouter());
  app.use(createCatalogRouter());
  app.use(createBillingRouter());
  app.use(createCustomerRouter());
  app.use(createSettingsRouter());
  app.use(createBranchRouter());
  app.use(createReportRouter());
  app.use(createSyncRouter());
  app.use(createSupportRouter());

  app.use(errorHandler(logger));

  return app;
}
