import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../core/prisma.js';
import {
  cleanupTestFixture,
  createTestFixture,
  hasTestDatabase,
  type TestFixture,
} from '../../test/db-fixtures.js';
import { openBatchForLoose, receiveBatch } from './batch.service.js';
import { getInventorySummary, updateProduct } from './inventory.service.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

describeIfDb('batch inventory value', () => {
  let fixture: TestFixture;
  let batchProductId: string;

  beforeAll(async () => {
    fixture = await createTestFixture();
    const product = await prisma.product.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Wire Batch ${Date.now()}`,
        sellPrice: 50,
        batchSellPrice: 5000,
        unit: 'meter',
        trackStock: true,
        trackType: 'BATCH',
        costPrice: null,
        stockQuantity: 0,
      },
    });
    batchProductId = product.id;
  });

  afterAll(async () => {
    await cleanupTestFixture(fixture.tenantId);
  });

  it('values all warehouse batches as batchCount × purchaseCost (not cost × meters)', async () => {
    await receiveBatch(
      fixture.tenantId,
      batchProductId,
      {
        purchaseDate: new Date().toISOString().slice(0, 10),
        quantityPerBatch: 90,
        batchCount: 4,
        purchaseCostPerBatch: 3000,
      },
      fixture.userId,
    );

    const summary = await getInventorySummary(fixture.tenantId);
    // 4 × 3000 = 12000 (even while all WAREHOUSE)
    expect(Number(summary.inventoryValue)).toBeCloseTo(12000, 1);
  });

  it('keeps full value after opening one batch; drops by sold share; ignores CLOSED', async () => {
    const warehouse = await prisma.batch.findMany({
      where: { tenantId: fixture.tenantId, productId: batchProductId, status: 'WAREHOUSE' },
      orderBy: { createdAt: 'asc' },
    });
    expect(warehouse.length).toBeGreaterThanOrEqual(2);

    await openBatchForLoose(fixture.tenantId, warehouse[0]!.id);
    await openBatchForLoose(fixture.tenantId, warehouse[1]!.id);

    let summary = await getInventorySummary(fixture.tenantId);
    expect(Number(summary.inventoryValue)).toBeCloseTo(12000, 1);

    // Sell 40m from first open batch → remove 40 × (3000/90) = 1333.333…
    await prisma.batch.update({
      where: { id: warehouse[0]!.id },
      data: { remainingQuantity: 50 },
    });
    await prisma.product.update({
      where: { id: batchProductId },
      data: { stockQuantity: 320 }, // 90*3 + 50
    });

    summary = await getInventorySummary(fixture.tenantId);
    expect(Number(summary.inventoryValue)).toBeCloseTo(10666.67, 1);

    // Close one remaining full open batch → remove exactly 3000
    await prisma.batch.update({
      where: { id: warehouse[1]!.id },
      data: { remainingQuantity: 0, status: 'CLOSED' },
    });
    await prisma.product.update({
      where: { id: batchProductId },
      data: { stockQuantity: 230 },
    });

    summary = await getInventorySummary(fixture.tenantId);
    // Was ~10666.67 minus full open batch 3000 ≈ 7666.67
    expect(Number(summary.inventoryValue)).toBeCloseTo(7666.67, 1);
  });

  it('clears stale SIMPLE cost×stock when converting to BATCH', async () => {
    const simple = await prisma.product.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Simple Spare ${Date.now()}`,
        sellPrice: 100,
        costPrice: 80,
        stockQuantity: 1000,
        trackStock: true,
        trackType: 'SIMPLE',
      },
    });

    const before = await getInventorySummary(fixture.tenantId);
    const beforeVal = Number(before.inventoryValue);

    await updateProduct(fixture.tenantId, simple.id, {
      trackType: 'BATCH',
      batchSellPrice: 5000,
      sellPrice: 100,
      costPrice: null,
    });

    const after = await getInventorySummary(fixture.tenantId);
    // Stale 80×1000 = 80000 must leave the total
    expect(Number(after.inventoryValue)).toBeCloseTo(beforeVal - 80000, 1);

    const updated = await prisma.product.findUnique({ where: { id: simple.id } });
    expect(updated!.costPrice).toBeNull();
    expect(Number(updated!.stockQuantity)).toBe(0);
    expect(updated!.trackType).toBe('BATCH');
  });
});
