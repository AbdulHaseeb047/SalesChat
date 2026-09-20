import { z } from 'zod';

import { NotFoundError, ValidationError } from '../core/errors.js';
import { toDecimal, formatDisplayDecimal } from '../core/money.js';
import { prisma, type TransactionClient } from '../core/prisma.js';
import { SYNC_TABLES, syncInsert, syncUpdate } from '../sync/sync-payload.js';

export const receiveBatchSchema = z
  .object({
    purchaseDate: z.string().min(1),
    supplier: z.string().max(255).optional().nullable(),
    purchaseReference: z.string().max(100).optional().nullable(),
    /** Legacy: cost per product unit. */
    costPerUnit: z.number().nonnegative().optional(),
    /** Amount paid for one physical batch (coil/cylinder). */
    purchaseCostPerBatch: z.number().positive().optional(),
    /** Legacy alias for purchaseCostPerBatch. */
    totalPurchaseCost: z.number().positive().optional(),
    /** How many physical batches (coils/cylinders) are being received. */
    batchCount: z.coerce.number().int().positive().max(500).optional(),
    /** Quantity in product unit inside each physical batch. */
    quantityPerBatch: z.coerce.number().positive().optional(),
    /** Legacy alias for quantityPerBatch. */
    initialQuantity: z.coerce.number().positive().optional(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .refine(
    (data) =>
      data.purchaseCostPerBatch != null ||
      data.totalPurchaseCost != null ||
      data.costPerUnit != null,
    {
      message: 'Enter the purchase cost for one batch',
      path: ['purchaseCostPerBatch'],
    },
  )
  .refine((data) => data.quantityPerBatch != null || data.initialQuantity != null, {
    message: 'Enter quantity per batch',
    path: ['quantityPerBatch'],
  });

/** Set absolute remaining quantity on a batch (reconciliation / physical weigh). */
export const adjustBatchSchema = z.object({
  remainingQuantity: z.number().nonnegative(),
  reason: z.string().min(3).max(2000),
  /** Optional: mark damaged instead of open/closed. */
  markDamaged: z.boolean().optional(),
});

/** Write off remaining gas and close a cylinder batch. */
export const closeOutBatchSchema = z.object({
  reason: z.string().min(3).max(2000),
});

function serializeBatch(b: {
  id: string;
  productId: string;
  purchaseDate: Date;
  supplier: string | null;
  purchaseReference: string | null;
  costPerUnit: Parameters<typeof formatDisplayDecimal>[0];
  initialQuantity: Parameters<typeof formatDisplayDecimal>[0];
  remainingQuantity: Parameters<typeof formatDisplayDecimal>[0];
  status: string;
  notes: string | null;
  closedAt?: Date | null;
  gasLossQuantity?: Parameters<typeof formatDisplayDecimal>[0] | null;
  gasLossCost?: Parameters<typeof formatDisplayDecimal>[0] | null;
  createdAt: Date;
  updatedAt: Date;
  product?: { id: string; name: string; unit: string } | null;
}) {
  return {
    id: b.id,
    productId: b.productId,
    purchaseDate: b.purchaseDate.toISOString().slice(0, 10),
    supplier: b.supplier,
    purchaseReference: b.purchaseReference,
    costPerUnit: formatDisplayDecimal(b.costPerUnit, 2),
    initialQuantity: formatDisplayDecimal(b.initialQuantity, 2),
    remainingQuantity: formatDisplayDecimal(b.remainingQuantity, 2),
    status: b.status,
    notes: b.notes,
    closedAt: b.closedAt?.toISOString() ?? null,
    gasLossQuantity:
      b.gasLossQuantity != null ? formatDisplayDecimal(b.gasLossQuantity, 2) : null,
    gasLossCost: b.gasLossCost != null ? formatDisplayDecimal(b.gasLossCost, 2) : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    product: b.product
      ? { id: b.product.id, name: b.product.name, unit: b.product.unit }
      : undefined,
  };
}

/**
 * Receive one or more physical batches (coils/cylinders). Each gets its own
 * WAREHOUSE batch row; product.stock_quantity increases by the combined qty.
 */
export async function receiveBatch(
  tenantId: string,
  productId: string,
  input: z.infer<typeof receiveBatchSchema>,
  createdById: string,
) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    if (!product) throw new NotFoundError('Product not found');
    if (product.trackType !== 'BATCH') {
      throw new ValidationError(
        'Only batch-tracked products can receive stock as batches. Set track type to Batch first.',
      );
    }
    if (!product.trackStock) {
      throw new ValidationError('Stock tracking is disabled for this product');
    }

    const batchCount = Math.min(500, Math.max(1, Math.trunc(input.batchCount ?? 1)));
    const qtyPerBatchRaw = input.quantityPerBatch ?? input.initialQuantity;
    if (qtyPerBatchRaw == null || qtyPerBatchRaw <= 0) {
      throw new ValidationError('Enter quantity per batch');
    }
    const qtyPerBatch = toDecimal(qtyPerBatchRaw);
    const totalQty = qtyPerBatch.times(batchCount);

    const purchaseCostPerBatch =
      input.purchaseCostPerBatch ?? input.totalPurchaseCost ?? null;

    let costPerUnit: ReturnType<typeof toDecimal>;
    if (purchaseCostPerBatch != null) {
      const batchSellPrice = product.batchSellPrice ?? product.sellPrice;
      const purchaseCost = toDecimal(purchaseCostPerBatch);
      if (purchaseCost.gt(batchSellPrice)) {
        throw new ValidationError(
          `Purchase cost per batch cannot exceed whole batch sell price (${batchSellPrice.toFixed(2)})`,
        );
      }
      costPerUnit = purchaseCost.div(qtyPerBatch);
      if (costPerUnit.gt(product.sellPrice)) {
        throw new ValidationError(
          `Cost per ${product.unit} exceeds retail rate (${product.sellPrice.toFixed(2)})`,
        );
      }
    } else if (input.costPerUnit != null) {
      costPerUnit = toDecimal(input.costPerUnit);
    } else {
      throw new ValidationError('Enter the purchase cost for one batch');
    }

    const purchaseDate = new Date(input.purchaseDate);
    if (Number.isNaN(purchaseDate.getTime())) {
      throw new ValidationError('Invalid purchase date');
    }

    const noteText = input.notes?.trim() || null;
    const createdBatches = [];

    for (let i = 0; i < batchCount; i++) {
      const batch = await tx.batch.create({
        data: {
          tenantId,
          productId,
          purchaseDate,
          supplier: input.supplier?.trim() || null,
          purchaseReference: input.purchaseReference?.trim() || null,
          costPerUnit,
          initialQuantity: qtyPerBatch,
          remainingQuantity: qtyPerBatch,
          status: 'WAREHOUSE',
          notes: noteText,
          createdById,
        },
        include: {
          product: { select: { id: true, name: true, unit: true } },
        },
      });
      createdBatches.push(batch);
    }

    const newStock = product.stockQuantity.plus(totalQty);
    const updatedProduct = await tx.product.update({
      where: { id: productId },
      data: { stockQuantity: newStock },
    });

    let runningStock = product.stockQuantity;
    for (let i = 0; i < createdBatches.length; i++) {
      const batch = createdBatches[i]!;
      runningStock = runningStock.plus(qtyPerBatch);
      const movement = await tx.stockMovement.create({
        data: {
          tenantId,
          productId,
          batchId: batch.id,
          movementType: 'STOCK_IN',
          quantityDelta: qtyPerBatch,
          quantityAfter: runningStock,
          referenceType: 'batch_receive',
          referenceId: batch.id,
          notes:
            noteText ||
            `Received batch (${qtyPerBatch.toFixed(3)} ${product.unit}${
              batchCount > 1 ? `, ${i + 1}/${batchCount}` : ''
            })`,
          recordedById: createdById,
        },
      });
      await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
    }

    await syncUpdate(tx, SYNC_TABLES.products, updatedProduct);

    const serialized = createdBatches.map(serializeBatch);
    return {
      batch: serialized[0]!,
      batches: serialized,
      batchCount,
      quantityPerBatch: qtyPerBatch.toFixed(3),
      totalQuantity: totalQty.toFixed(3),
      stockQuantity: newStock.toFixed(3),
    };
  });
}

export type BatchStockCounts = { warehouse: number; open: number; total: number };

/** Count active batches per product — warehouse (not yet opened) vs open on counter. */
export async function getBatchStockCounts(
  tenantId: string,
  productIds?: string[],
): Promise<Map<string, BatchStockCounts>> {
  if (productIds && productIds.length === 0) return new Map();

  const rows = await prisma.batch.groupBy({
    by: ['productId', 'status'],
    where: {
      tenantId,
      ...(productIds?.length ? { productId: { in: productIds } } : {}),
      status: { in: ['WAREHOUSE', 'OPEN'] },
      remainingQuantity: { gt: 0 },
      product: { deletedAt: null },
    },
    _count: { _all: true },
  });

  const map = new Map<string, BatchStockCounts>();
  for (const r of rows) {
    const cur = map.get(r.productId) ?? { warehouse: 0, open: 0, total: 0 };
    const n = r._count._all;
    if (r.status === 'WAREHOUSE') cur.warehouse = n;
    if (r.status === 'OPEN') cur.open = n;
    cur.total = cur.warehouse + cur.open;
    map.set(r.productId, cur);
  }
  return map;
}

/** @deprecated Use getBatchStockCounts — returns warehouse + open combined. */
export async function getActiveBatchCounts(
  tenantId: string,
  productIds?: string[],
): Promise<Map<string, number>> {
  const counts = await getBatchStockCounts(tenantId, productIds);
  return new Map([...counts.entries()].map(([id, c]) => [id, c.total]));
}

export async function listProductBatches(
  tenantId: string,
  productId: string,
  options?: { status?: 'WAREHOUSE' | 'OPEN' | 'CLOSED' | 'DAMAGED' | 'all' },
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new NotFoundError('Product not found');

  const status = options?.status && options.status !== 'all' ? options.status : undefined;

  const batches = await prisma.batch.findMany({
    where: {
      tenantId,
      productId,
      ...(status ? { status } : {}),
    },
    include: {
      product: { select: { id: true, name: true, unit: true } },
    },
    orderBy: [{ status: 'asc' }, { purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });

  return batches.map(serializeBatch);
}

/** Open counter batches across products — loose sales at a glance. */
export async function listOpenBatches(tenantId: string, productId?: string) {
  const batches = await prisma.batch.findMany({
    where: {
      tenantId,
      status: 'OPEN',
      ...(productId ? { productId } : {}),
      product: { deletedAt: null },
    },
    include: {
      product: { select: { id: true, name: true, unit: true } },
    },
    orderBy: [{ product: { name: 'asc' } }, { purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });

  return batches.map(serializeBatch);
}

/**
 * Move a warehouse batch to the counter for loose/partial sales.
 * Multiple batches per product can be OPEN at once.
 */
export async function openBatchForLoose(tenantId: string, batchId: string) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        product: { select: { id: true, name: true, unit: true, deletedAt: true } },
      },
    });
    if (!batch || batch.product.deletedAt) throw new NotFoundError('Batch not found');
    if (batch.status !== 'WAREHOUSE') {
      throw new ValidationError('Only warehouse batches can be opened for loose sales');
    }
    if (batch.remainingQuantity.lte(0)) {
      throw new ValidationError('This batch has no stock left to open');
    }

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: { status: 'OPEN' },
      include: {
        product: { select: { id: true, name: true, unit: true } },
      },
    });

    return { batch: serializeBatch(updated) };
  });
}

/**
 * Manual reconciliation: set a batch's remaining_quantity with a required reason.
 * Updates product.stock_quantity by the delta. Logged as ADJUSTMENT (never a sale).
 */
export async function adjustBatch(
  tenantId: string,
  batchId: string,
  input: z.infer<typeof adjustBatchSchema>,
  recordedById: string,
) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        product: {
          select: { id: true, name: true, unit: true, trackStock: true, deletedAt: true },
        },
      },
    });
    if (!batch || batch.product.deletedAt) throw new NotFoundError('Batch not found');
    if (batch.status === 'DAMAGED' && !input.markDamaged) {
      throw new ValidationError('This batch is marked damaged and cannot be adjusted.');
    }

    const newRemaining = toDecimal(input.remainingQuantity);
    if (newRemaining.gt(batch.initialQuantity)) {
      throw new ValidationError(
        `Remaining cannot exceed initial quantity (${batch.initialQuantity.toFixed(3)} ${batch.product.unit})`,
      );
    }

    const reason = input.reason.trim();
    if (reason.length < 3) throw new ValidationError('Reason is required');

    const closeTolRow = await tx.businessSettings.findUnique({
      where: { tenantId },
      select: { batchCloseTolerance: true },
    });
    const closeTolerance = closeTolRow?.batchCloseTolerance ?? toDecimal(0.1);

    let nextStatus: 'WAREHOUSE' | 'OPEN' | 'CLOSED' | 'DAMAGED' = batch.status;
    if (input.markDamaged) {
      nextStatus = 'DAMAGED';
    } else if (newRemaining.lte(closeTolerance)) {
      nextStatus = 'CLOSED';
    } else if (batch.status === 'CLOSED' && newRemaining.gt(closeTolerance)) {
      nextStatus = newRemaining.eq(batch.initialQuantity) ? 'WAREHOUSE' : 'OPEN';
    } else if (batch.status === 'WAREHOUSE' || batch.status === 'OPEN') {
      nextStatus = batch.status;
    }

    const appliedRemaining =
      nextStatus === 'CLOSED' && newRemaining.lte(closeTolerance) ? toDecimal(0) : newRemaining;
    const delta = appliedRemaining.minus(batch.remainingQuantity);

    const updatedBatch = await tx.batch.update({
      where: { id: batchId },
      data: {
        remainingQuantity: appliedRemaining,
        status: nextStatus,
      },
      include: {
        product: { select: { id: true, name: true, unit: true } },
      },
    });

    let stockQuantity =
      (
        await tx.product.findUnique({
          where: { id: batch.productId },
          select: { stockQuantity: true },
        })
      )?.stockQuantity ?? toDecimal(0);

    if (batch.product.trackStock && !delta.eq(0)) {
      const productRows = await tx.$queryRaw<{ stock_quantity: typeof batch.remainingQuantity }[]>`
        UPDATE products
        SET stock_quantity = stock_quantity + ${delta},
            updated_at = NOW(),
            version = version + 1
        WHERE id = ${batch.productId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND track_stock = true
          AND stock_quantity + ${delta} >= 0
        RETURNING stock_quantity
      `;
      if (!productRows[0]) {
        throw new ValidationError(
          'Adjustment would make product stock negative. Check other open batches or receive stock first.',
        );
      }
      stockQuantity = productRows[0].stock_quantity;

      const movement = await tx.stockMovement.create({
        data: {
          tenantId,
          productId: batch.productId,
          batchId: batch.id,
          movementType: 'ADJUSTMENT',
          quantityDelta: delta,
          quantityAfter: stockQuantity,
          referenceType: 'batch_adjustment',
          referenceId: batch.id,
          notes: `Batch reconciliation: ${reason}`,
          recordedById,
        },
      });

      const productRow = await tx.product.findUnique({ where: { id: batch.productId } });
      if (productRow) await syncUpdate(tx, SYNC_TABLES.products, productRow);
      await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
    } else if (nextStatus !== batch.status) {
      const movement = await tx.stockMovement.create({
        data: {
          tenantId,
          productId: batch.productId,
          batchId: batch.id,
          movementType: 'ADJUSTMENT',
          quantityDelta: toDecimal(0),
          quantityAfter: stockQuantity,
          referenceType: 'batch_adjustment',
          referenceId: batch.id,
          notes: `Batch reconciliation: ${reason}`,
          recordedById,
        },
      });
      await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
    }

    return {
      batch: serializeBatch(updatedBatch),
      quantityDelta: delta.toFixed(3),
      stockQuantity: stockQuantity.toFixed(3),
    };
  });
}

/**
 * Write off all remaining gas on an open batch, close the cylinder, and record gas-loss COGS.
 */
export async function closeOutBatch(
  tenantId: string,
  batchId: string,
  input: z.infer<typeof closeOutBatchSchema>,
  recordedById: string,
) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        product: {
          select: { id: true, name: true, unit: true, trackStock: true, deletedAt: true },
        },
      },
    });
    if (!batch || batch.product.deletedAt) throw new NotFoundError('Batch not found');
    if (batch.status !== 'OPEN') {
      throw new ValidationError('Only open batches can be closed with a gas loss write-off');
    }

    const gasLossQty = batch.remainingQuantity;
    if (gasLossQty.lte(0)) {
      throw new ValidationError('This batch has no remaining gas to write off');
    }

    const reason = input.reason.trim();
    const gasLossCost = gasLossQty.times(batch.costPerUnit);
    const closedAt = new Date();

    const updatedBatch = await tx.batch.update({
      where: { id: batchId },
      data: {
        remainingQuantity: toDecimal(0),
        status: 'CLOSED',
        closedAt,
        gasLossQuantity: gasLossQty,
        gasLossCost,
      },
      include: {
        product: { select: { id: true, name: true, unit: true } },
      },
    });

    let stockQuantity =
      (
        await tx.product.findUnique({
          where: { id: batch.productId },
          select: { stockQuantity: true },
        })
      )?.stockQuantity ?? toDecimal(0);

    if (batch.product.trackStock) {
      const gasLossStr = gasLossQty.toFixed(3);
      const productRows = await tx.$queryRaw<{ stock_quantity: typeof batch.remainingQuantity }[]>`
        UPDATE products
        SET stock_quantity = stock_quantity - ${gasLossStr}::numeric,
            updated_at = NOW(),
            version = version + 1
        WHERE id = ${batch.productId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND track_stock = true
          AND stock_quantity >= ${gasLossStr}::numeric
        RETURNING stock_quantity
      `;
      if (!productRows[0]) {
        throw new ValidationError(
          'Gas loss write-off would make product stock negative. Check other open batches first.',
        );
      }
      stockQuantity = productRows[0].stock_quantity;

      const movement = await tx.stockMovement.create({
        data: {
          tenantId,
          productId: batch.productId,
          batchId: batch.id,
          movementType: 'ADJUSTMENT',
          quantityDelta: gasLossQty.negated(),
          quantityAfter: stockQuantity,
          referenceType: 'gas_loss_writeoff',
          referenceId: batch.id,
          notes: `Gas loss close-out: ${reason} (${gasLossQty.toFixed(3)} ${batch.product.unit})`,
          recordedById,
        },
      });

      const productRow = await tx.product.findUnique({ where: { id: batch.productId } });
      if (productRow) await syncUpdate(tx, SYNC_TABLES.products, productRow);
      await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
    }

    const summary = await buildBatchSummary(tx, tenantId, batchId);

    return {
      batch: serializeBatch(updatedBatch),
      gasLossQuantity: gasLossQty.toFixed(3),
      gasLossCost: gasLossCost.toFixed(4),
      stockQuantity: stockQuantity.toFixed(3),
      summary,
    };
  });
}

async function buildBatchSummary(
  db: TransactionClient | typeof prisma,
  tenantId: string,
  batchId: string,
) {
  const batch = await db.batch.findFirst({
    where: { id: batchId, tenantId },
    include: { product: { select: { id: true, name: true, unit: true } } },
  });
  if (!batch) throw new NotFoundError('Batch not found');

  const saleItems = await db.saleItem.findMany({
    where: {
      tenantId,
      batchId,
      sale: { status: 'COMPLETED' },
    },
    select: {
      quantity: true,
      quantityDeducted: true,
      lineTotal: true,
      unitCostAtSale: true,
    },
  });

  let revenue = toDecimal(0);
  let cogsSold = toDecimal(0);
  for (const item of saleItems) {
    revenue = revenue.plus(item.lineTotal);
    const unitCost = item.unitCostAtSale ?? batch.costPerUnit;
    cogsSold = cogsSold.plus(unitCost.times(item.quantityDeducted ?? item.quantity));
  }

  const saleCount = saleItems.length;
  const purchaseCost = batch.initialQuantity.times(batch.costPerUnit);
  const isClosed = batch.status === 'CLOSED';

  const gasLossQty = isClosed
    ? (batch.gasLossQuantity ?? toDecimal(0))
    : batch.remainingQuantity;
  const gasLossCost = isClosed
    ? (batch.gasLossCost ?? toDecimal(0))
    : batch.remainingQuantity.times(batch.costPerUnit);

  const netProfit = revenue.minus(cogsSold).minus(gasLossCost);
  const avgLossPerCharge =
    isClosed && saleCount > 0 && gasLossQty.gt(0)
      ? gasLossQty.div(saleCount)
      : null;
  const effectiveLossPercent = batch.initialQuantity.gt(0)
    ? gasLossQty.div(batch.initialQuantity).times(100)
    : toDecimal(0);

  return {
    batchId: batch.id,
    status: batch.status,
    unit: batch.product.unit,
    productName: batch.product.name,
    purchaseCost: formatDisplayDecimal(purchaseCost, 2),
    revenue: formatDisplayDecimal(revenue, 2),
    cogsSold: formatDisplayDecimal(cogsSold, 2),
    gasLossQuantity: formatDisplayDecimal(gasLossQty, 2),
    gasLossCost: formatDisplayDecimal(gasLossCost, 2),
    netProfit: formatDisplayDecimal(netProfit, 2),
    saleCount,
    avgLossPerCharge:
      avgLossPerCharge != null ? formatDisplayDecimal(avgLossPerCharge, 2) : null,
    effectiveLossPercent: formatDisplayDecimal(effectiveLossPercent, 2),
    isFinal: isClosed,
    remainingQuantity: formatDisplayDecimal(batch.remainingQuantity, 2),
    initialQuantity: formatDisplayDecimal(batch.initialQuantity, 2),
    costPerUnit: formatDisplayDecimal(batch.costPerUnit, 2),
    closedAt: batch.closedAt?.toISOString() ?? null,
  };
}

export async function getBatchSummary(tenantId: string, batchId: string) {
  return buildBatchSummary(prisma, tenantId, batchId);
}
