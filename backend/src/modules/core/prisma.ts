import { PrismaClient } from '@prisma/client';

import { getTenantContext } from './tenant-context.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Models that always carry tenant_id and should be auto-scoped when context is set. */
const TENANT_SCOPED_MODELS = new Set([
  'Category',
  'ShopPart',
  'Brand',
  'Supplier',
  'SupplierLedgerEntry',
  'Product',
  'StockMovement',
  'Customer',
  'CustomerLedgerEntry',
  'CustomerCreditObligation',
  'CustomerPaymentAllocation',
  'FinancialEntry',
  'Sale',
  'SaleItem',
  'SalePayment',
  'HeldCart',
  'GiftCard',
  'SaleReturn',
  'SaleReturnItem',
  'DiscountRule',
  'DiscountUsage',
  'BusinessSettings',
  'Branch',
  'SaleSequence',
  'SyncOutbox',
  'SyncState',
  'SyncChangelog',
  'SyncDevice',
  'TenantFeature',
  'LicenseActivation',
  'AuditLog',
]);

function injectTenantWhere<T extends { where?: Record<string, unknown> }>(
  model: string,
  args: T,
): T {
  const ctx = getTenantContext();
  if (!ctx?.tenantId || ctx.bypass || !TENANT_SCOPED_MODELS.has(model)) return args;
  const where = args.where ?? {};
  if ('tenantId' in where) return args;
  return { ...args, where: { ...where, tenantId: ctx.tenantId } };
}

function injectTenantData<T extends { data?: Record<string, unknown> | Record<string, unknown>[] }>(
  model: string,
  args: T,
): T {
  const ctx = getTenantContext();
  if (!ctx?.tenantId || ctx.bypass || !TENANT_SCOPED_MODELS.has(model) || !args.data) return args;
  if (Array.isArray(args.data)) {
    return {
      ...args,
      data: args.data.map((row) => ('tenantId' in row ? row : { ...row, tenantId: ctx.tenantId })),
    };
  }
  if ('tenantId' in args.data) return args;
  return { ...args, data: { ...args.data, tenantId: ctx.tenantId } };
}

async function applyRlsLocalOnTx(tx: {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}): Promise<void> {
  // Skip unless explicitly enabled — remote pooler latency makes SET CONFIG expensive.
  if (process.env.ENABLE_RLS_SESSION !== 'true') return;
  const ctx = getTenantContext();
  if (!ctx) return;
  const tenantId = ctx.tenantId ?? '';
  const bypass = ctx.bypass ? 'true' : 'false';
  await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', ${bypass}, true)`;
}

const DEFAULT_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

function databaseUrlWithConnectionLimit(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;
  const limit = process.env.PRISMA_CONNECTION_LIMIT?.trim() || '5';
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${encodeURIComponent(limit)}`;
}

function createPrismaClient(): PrismaClient {
  const databaseUrl = databaseUrlWithConnectionLimit();
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });

  const extended = base.$extends({
    name: 'tenantRls',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          let next = args as Record<string, unknown>;
          if (
            operation === 'findMany' ||
            operation === 'findFirst' ||
            operation === 'findUnique' ||
            operation === 'count' ||
            operation === 'aggregate' ||
            operation === 'groupBy' ||
            operation === 'update' ||
            operation === 'updateMany' ||
            operation === 'delete' ||
            operation === 'deleteMany'
          ) {
            next = injectTenantWhere(model, next as { where?: Record<string, unknown> });
          }
          if (operation === 'create' || operation === 'createMany') {
            next = injectTenantData(model, next as { data?: Record<string, unknown> });
          }
          if (operation === 'upsert') {
            next = injectTenantWhere(model, next as { where?: Record<string, unknown> });
            const ctx = getTenantContext();
            if (ctx?.tenantId && !ctx.bypass && TENANT_SCOPED_MODELS.has(model)) {
              const upsertArgs = next as {
                create?: Record<string, unknown>;
                update?: Record<string, unknown>;
              };
              if (upsertArgs.create && !('tenantId' in upsertArgs.create)) {
                upsertArgs.create = { ...upsertArgs.create, tenantId: ctx.tenantId };
              }
            }
          }
          return query(next);
        },
      },
    },
  });

  // SET LOCAL on the same connection as interactive transactions (fixes pooled RLS 500s).
  const client = extended as unknown as PrismaClient;
  const originalTransaction = client.$transaction.bind(client) as PrismaClient['$transaction'];

  (client as unknown as { $transaction: PrismaClient['$transaction'] }).$transaction = ((
    ...args: unknown[]
  ) => {
    if (typeof args[0] === 'function') {
      const fn = args[0] as (tx: TransactionClient) => Promise<unknown>;
      const options = {
        ...DEFAULT_TX_OPTIONS,
        ...(args[1] as object | undefined),
      } as Parameters<PrismaClient['$transaction']>[1];
      return originalTransaction(async (tx) => {
        await applyRlsLocalOnTx(tx);
        return fn(tx);
      }, options);
    }
    return (originalTransaction as (...a: unknown[]) => unknown)(...args);
  }) as PrismaClient['$transaction'];

  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
