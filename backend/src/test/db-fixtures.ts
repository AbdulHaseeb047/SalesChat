import { randomUUID } from 'node:crypto';

import { PrismaClient, TenantTier, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

import { createDefaultBranch } from '../modules/core/branch.js';

export const integrationPrisma = new PrismaClient();

export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export interface TestFixture {
  tenantId: string;
  branchId: string;
  userId: string;
  productId: string;
}

export async function createTestFixture(): Promise<TestFixture> {
  const suffix = randomUUID().slice(0, 8);

  const tenant = await integrationPrisma.tenant.create({
    data: {
      name: `Test Tenant ${suffix}`,
      slug: `test-${suffix}`,
      tier: TenantTier.STANDARD,
      businessSettings: {
        create: { businessName: `Test Biz ${suffix}` },
      },
    },
  });

  const branchId = await createDefaultBranch(tenant.id, tenant.name);

  const user = await integrationPrisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `cashier-${suffix}@test.local`,
      passwordHash: await argon2.hash('TestPass123!'),
      fullName: 'Test Cashier',
      role: UserRole.CLIENT_ADMIN,
    },
  });

  const product = await integrationPrisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Test Product',
      sellPrice: 100,
      trackStock: false,
    },
  });

  return {
    tenantId: tenant.id,
    branchId,
    userId: user.id,
    productId: product.id,
  };
}

export async function createTestCustomer(tenantId: string, name?: string) {
  return integrationPrisma.customer.create({
    data: {
      tenantId,
      name: name ?? `Customer ${randomUUID().slice(0, 6)}`,
    },
  });
}

export async function cleanupTestFixture(tenantId: string): Promise<void> {
  await integrationPrisma.customerPaymentAllocation.deleteMany({ where: { tenantId } });
  await integrationPrisma.customerCreditObligation.deleteMany({ where: { tenantId } });
  await integrationPrisma.customerLedgerEntry.deleteMany({ where: { tenantId } });
  await integrationPrisma.salePayment.deleteMany({ where: { tenantId } });
  await integrationPrisma.saleItem.deleteMany({ where: { tenantId } });
  await integrationPrisma.sale.deleteMany({ where: { tenantId } });
  await integrationPrisma.stockMovement.deleteMany({ where: { tenantId } });
  await integrationPrisma.batch.deleteMany({ where: { tenantId } });
  await integrationPrisma.auditLog.deleteMany({ where: { tenantId } });
  await integrationPrisma.product.deleteMany({ where: { tenantId } });
  await integrationPrisma.customer.deleteMany({ where: { tenantId } });
  await integrationPrisma.saleSequence.deleteMany({ where: { tenantId } });
  await integrationPrisma.syncOutbox.deleteMany({ where: { tenantId } });
  await integrationPrisma.syncChangelog.deleteMany({ where: { tenantId } });
  await integrationPrisma.syncDevice.deleteMany({ where: { tenantId } });
  await integrationPrisma.syncState.deleteMany({ where: { tenantId } });
  await integrationPrisma.staffFeature.deleteMany({ where: { user: { tenantId } } });
  await integrationPrisma.refreshToken.deleteMany({ where: { user: { tenantId } } });
  await integrationPrisma.user.deleteMany({ where: { tenantId } });
  await integrationPrisma.branch.deleteMany({ where: { tenantId } });
  await integrationPrisma.businessSettings.deleteMany({ where: { tenantId } });
  await integrationPrisma.tenantFeature.deleteMany({ where: { tenantId } });
  await integrationPrisma.tenant.delete({ where: { id: tenantId } });
}

export async function cleanupCustomer(tenantId: string, customerId: string): Promise<void> {
  await integrationPrisma.customerPaymentAllocation.deleteMany({
    where: { obligation: { customerId } },
  });
  await integrationPrisma.customerCreditObligation.deleteMany({ where: { customerId } });
  await integrationPrisma.customerLedgerEntry.deleteMany({ where: { customerId } });
  await integrationPrisma.salePayment.deleteMany({ where: { sale: { customerId } } });
  await integrationPrisma.saleItem.deleteMany({ where: { sale: { customerId } } });
  await integrationPrisma.sale.deleteMany({ where: { customerId } });
  await integrationPrisma.customer.delete({ where: { id: customerId, tenantId } });
}
