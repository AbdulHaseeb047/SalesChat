import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { TransactionClient } from '../core/prisma.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { prisma } from '../core/prisma.js';
import { toDecimal, formatDisplayDecimal } from '../core/money.js';
import {
  assertUniqueCompactName,
  compactText,
  findIdsByCompactSearch,
} from '../core/text-match.js';
import { SYNC_TABLES, syncInsert, syncUpdate } from '../sync/sync-payload.js';
import { ensureMiscProduct } from '../billing/misc-product.js';
import { getBatchStockCounts, type BatchStockCounts } from './batch.service.js';

type StockLevel = 'healthy' | 'low' | 'out';

function stockLevelForProduct(
  p: {
    trackStock: boolean;
    trackType?: string;
    stockQuantity: { toString(): string } | number;
    lowStockThreshold: { toString(): string } | number | null;
  },
  batchCounts?: BatchStockCounts,
): StockLevel {
  if (!p.trackStock) return 'healthy';
  const threshold = p.lowStockThreshold ? Number(p.lowStockThreshold) : 0;
  const qty =
    p.trackType === 'BATCH' ? (batchCounts?.total ?? 0) : Number(p.stockQuantity);
  if (qty <= 0) return 'out';
  if (threshold > 0 && qty <= threshold) return 'low';
  return 'healthy';
}

async function serializeProductsWithBatchCounts(
  tenantId: string,
  products: Parameters<typeof serializeProduct>[0][],
) {
  const batchIds = products.filter((p) => p.trackType === 'BATCH').map((p) => p.id);
  const batchCounts =
    batchIds.length > 0 ? await getBatchStockCounts(tenantId, batchIds) : new Map<string, BatchStockCounts>();
  return products.map((p) =>
    serializeProduct(p, p.trackType === 'BATCH' ? batchCounts.get(p.id) : undefined),
  );
}

async function serializeProductWithBatchCount(
  tenantId: string,
  product: Parameters<typeof serializeProduct>[0],
) {
  const batchCounts =
    product.trackType === 'BATCH'
      ? (await getBatchStockCounts(tenantId, [product.id])).get(product.id)
      : undefined;
  return serializeProduct(product, batchCounts);
}

export const categorySchema = z.object({
  name: z.string().min(1).max(255),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const shopPartSchema = z.object({
  name: z.string().min(1).max(255),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const bulkAssignPartSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(500),
  partId: z.string().uuid().nullable(),
});

export const productSchema = z.object({
  name: z.string().min(1).max(255),
  categoryId: z.string().uuid().optional().nullable(),
  partId: z.string().uuid().optional().nullable(),
  brandId: z.string().uuid().optional().nullable(),
  supplierId: z.string().uuid().optional().nullable(),
  sku: z.string().max(100).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  imageUrl: z.string().max(700_000).optional().nullable(),
  unit: z.string().max(50).optional(),
  costPrice: z.number().nonnegative().optional().nullable(),
  sellPrice: z.number().nonnegative(),
  batchSellPrice: z.number().nonnegative().optional().nullable(),
  taxRate: z.number().nonnegative().optional(),
  lowStockThreshold: z.number().nonnegative().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  trackStock: z.boolean().optional(),
  trackType: z.enum(['SIMPLE', 'BATCH']).optional(),
  dispensingLossPercent: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const stockAdjustSchema = z.object({
  quantityDelta: z.number(),
  movementType: z.enum(['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT']),
  notes: z.string().optional(),
});

export const importProductRowSchema = z.object({
  name: z.string().min(1).max(255),
  sellPrice: z.number().nonnegative(),
  costPrice: z.number().nonnegative().optional().nullable(),
  sku: z.string().max(100).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  unit: z.string().max(50).optional(),
  categoryName: z.string().max(255).optional().nullable(),
  partName: z.string().max(255).optional().nullable(),
  brandName: z.string().max(255).optional().nullable(),
  supplierName: z.string().max(255).optional().nullable(),
  stockQuantity: z.number().nonnegative().optional(),
  lowStockThreshold: z.number().nonnegative().optional().nullable(),
  trackStock: z.boolean().optional(),
  expiryDate: z.string().optional().nullable(),
});

export const importProductsSchema = z.object({
  rows: z.array(importProductRowSchema).min(1).max(5000),
  updateExisting: z.boolean().optional().default(true),
});

export async function listCategories(tenantId: string, search?: string) {
  const searchIds = await findIdsByCompactSearch('categories', tenantId, search ?? '', [], null);
  if (searchIds && searchIds.length === 0) return [];

  return prisma.category.findMany({
    where: {
      tenantId,
      deletedAt: null,
      ...(searchIds ? { id: { in: searchIds } } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function createCategory(tenantId: string, input: z.infer<typeof categorySchema>) {
  const name = input.name.trim();
  await assertUniqueCompactName('categories', tenantId, name, 'category');

  return prisma.$transaction(async (tx) => {
    const category = await tx.category.create({
      data: {
        tenantId,
        name,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
    await syncInsert(tx, SYNC_TABLES.categories, category);
    return category;
  });
}

export async function updateCategory(
  tenantId: string,
  id: string,
  input: Partial<z.infer<typeof categorySchema>>,
) {
  const cat = await prisma.category.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!cat) throw new NotFoundError('Category not found');

  const name = input.name?.trim();
  if (name) {
    await assertUniqueCompactName('categories', tenantId, name, 'category', id);
  }

  return prisma.$transaction(async (tx) => {
    const category = await tx.category.update({
      where: { id },
      data: { name, sortOrder: input.sortOrder, isActive: input.isActive },
    });
    await syncUpdate(tx, SYNC_TABLES.categories, category);
    return category;
  });
}

export async function deleteCategory(tenantId: string, id: string) {
  const cat = await prisma.category.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!cat) throw new NotFoundError('Category not found');
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await syncUpdate(tx, SYNC_TABLES.categories, category);
    return { success: true };
  });
}

async function backfillSaleItemsPartId(
  tx: TransactionClient,
  tenantId: string,
  productIds: string[],
  partId: string | null,
) {
  if (productIds.length === 0) return;
  await tx.saleItem.updateMany({
    where: { tenantId, productId: { in: productIds }, partId: null },
    data: { partId },
  });
}

export async function listShopParts(tenantId: string, search?: string) {
  const searchIds = await findIdsByCompactSearch('shop_parts', tenantId, search ?? '', [], null);
  if (searchIds && searchIds.length === 0) return [];

  return prisma.shopPart.findMany({
    where: {
      tenantId,
      deletedAt: null,
      ...(searchIds ? { id: { in: searchIds } } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function createShopPart(tenantId: string, input: z.infer<typeof shopPartSchema>) {
  const name = input.name.trim();
  await assertUniqueCompactName('shop_parts', tenantId, name, 'shop part');

  return prisma.$transaction(async (tx) => {
    const part = await tx.shopPart.create({
      data: {
        tenantId,
        name,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
    await syncInsert(tx, SYNC_TABLES.shopParts, part);
    return part;
  });
}

export async function updateShopPart(
  tenantId: string,
  id: string,
  input: Partial<z.infer<typeof shopPartSchema>>,
) {
  const part = await prisma.shopPart.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!part) throw new NotFoundError('Shop part not found');

  const name = input.name?.trim();
  if (name) {
    await assertUniqueCompactName('shop_parts', tenantId, name, 'shop part', id);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.shopPart.update({
      where: { id },
      data: { name, sortOrder: input.sortOrder, isActive: input.isActive },
    });
    await syncUpdate(tx, SYNC_TABLES.shopParts, updated);
    return updated;
  });
}

export async function deleteShopPart(tenantId: string, id: string) {
  const part = await prisma.shopPart.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!part) throw new NotFoundError('Shop part not found');
  return prisma.$transaction(async (tx) => {
    await tx.product.updateMany({
      where: { tenantId, partId: id },
      data: { partId: null },
    });
    const updated = await tx.shopPart.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await syncUpdate(tx, SYNC_TABLES.shopParts, updated);
    return { success: true };
  });
}

export async function bulkAssignProductsToPart(
  tenantId: string,
  input: z.infer<typeof bulkAssignPartSchema>,
) {
  await assertShopPartOwned(tenantId, input.partId);

  const products = await prisma.product.findMany({
    where: { tenantId, id: { in: input.productIds }, deletedAt: null },
    select: { id: true },
  });
  if (products.length === 0) throw new NotFoundError('No matching products found');

  const productIds = products.map((p) => p.id);

  return prisma.$transaction(async (tx) => {
    for (const productId of productIds) {
      const updated = await tx.product.update({
        where: { id: productId },
        data: { partId: input.partId },
      });
      await syncUpdate(tx, SYNC_TABLES.products, updated);
    }
    await backfillSaleItemsPartId(tx, tenantId, productIds, input.partId);
    return { updated: productIds.length, partId: input.partId };
  });
}

export async function listProducts(
  tenantId: string,
  options?: {
    search?: string;
    categoryId?: string;
    partId?: string;
    brandId?: string;
    stockStatus?: 'all' | 'healthy' | 'low' | 'out';
    page?: number;
    pageSize?: number;
    /** Sale register catalog — active items only. */
    activeOnly?: boolean;
    /** Skip COUNT(*) for faster catalog loads. */
    skipCount?: boolean;
    /** Fetch specific product ids (order preserved in response). */
    ids?: string[];
  },
) {
  const page = options?.page ?? 1;
  const pageSize = Math.min(options?.pageSize ?? 50, 5000);
  const skip = (page - 1) * pageSize;
  const idFilter =
    options?.ids && options.ids.length > 0 ? Array.from(new Set(options.ids)).slice(0, 40) : null;

  if (idFilter) {
    const include = {
      category: { select: { id: true, name: true } },
      part: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    } as const;
    const products = await prisma.product.findMany({
      where: {
        tenantId,
        deletedAt: null,
        id: { in: idFilter },
        ...(options?.activeOnly ? { isActive: true } : {}),
      },
      include,
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const ordered = idFilter
      .map((id) => byId.get(id))
      .filter((p): p is (typeof products)[number] => Boolean(p));
    const data = await serializeProductsWithBatchCounts(tenantId, ordered);
    return {
      data,
      meta: { total: ordered.length, page: 1, pageSize: ordered.length, totalPages: 1 },
    };
  }

  const searchIds = await findIdsByCompactSearch(
    'products',
    tenantId,
    options?.search ?? '',
    ['sku', 'barcode'],
    null,
  );

  if (searchIds && searchIds.length === 0) {
    return {
      data: [],
      meta: { total: 0, page, pageSize, totalPages: 0 },
    };
  }

  const where: Prisma.ProductWhereInput = {
    tenantId,
    deletedAt: null,
    ...(options?.activeOnly ? { isActive: true } : {}),
    ...(options?.categoryId ? { categoryId: options.categoryId } : {}),
    ...(options?.partId === '__unassigned__' ? { partId: null } : {}),
    ...(options?.partId && options.partId !== '__unassigned__'
      ? { partId: options.partId }
      : {}),
    ...(options?.brandId ? { brandId: options.brandId } : {}),
    ...(searchIds ? { id: { in: searchIds } } : {}),
  };

  const include = {
    category: { select: { id: true, name: true } },
    part: { select: { id: true, name: true } },
    brand: { select: { id: true, name: true } },
    supplier: { select: { id: true, name: true } },
  } as const;

  if (options?.stockStatus && options.stockStatus !== 'all') {
    const products = await prisma.product.findMany({
      where,
      include,
      orderBy: { name: 'asc' },
    });
    const batchIds = products.filter((p) => p.trackType === 'BATCH').map((p) => p.id);
    const batchCounts =
      batchIds.length > 0 ? await getBatchStockCounts(tenantId, batchIds) : new Map<string, BatchStockCounts>();
    const filtered = products.filter(
      (p) =>
        stockLevelForProduct(
          p,
          p.trackType === 'BATCH' ? batchCounts.get(p.id) : undefined,
        ) === options.stockStatus,
    );
    const total = filtered.length;
    const pageRows = filtered.slice(skip, skip + pageSize);
    const data = pageRows.map((p) =>
      serializeProduct(p, p.trackType === 'BATCH' ? batchCounts.get(p.id) : undefined),
    );
    return {
      data,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    };
  }

  const products = await prisma.product.findMany({
    where,
    include,
    orderBy: { name: 'asc' },
    skip,
    take: pageSize,
  });
  const total = options?.skipCount ? products.length + skip : await prisma.product.count({ where });
  const data = await serializeProductsWithBatchCounts(tenantId, products);

  return {
    data,
    meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
  };
}

export async function getInventorySummary(tenantId: string) {
  const [products, valuedBatches, batchCounts] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId, deletedAt: null, isActive: true },
      select: {
        id: true,
        costPrice: true,
        sellPrice: true,
        stockQuantity: true,
        trackStock: true,
        trackType: true,
        lowStockThreshold: true,
      },
    }),
    prisma.batch.findMany({
      where: {
        tenantId,
        status: { in: ['WAREHOUSE', 'OPEN'] },
        remainingQuantity: { gt: 0 },
        product: { deletedAt: null, isActive: true },
      },
      select: {
        productId: true,
        remainingQuantity: true,
        costPerUnit: true,
      },
    }),
    getBatchStockCounts(tenantId),
  ]);

  const batchValueByProduct = new Map<string, { value: number; qty: number; costSum: number }>();
  for (const b of valuedBatches) {
    const rem = Number(b.remainingQuantity);
    const cpu = Number(b.costPerUnit);
    const cur = batchValueByProduct.get(b.productId) ?? { value: 0, qty: 0, costSum: 0 };
    cur.value += rem * cpu;
    cur.qty += rem;
    cur.costSum += rem * cpu;
    batchValueByProduct.set(b.productId, cur);
  }

  let totalValue = 0;
  let projectedProfit = 0;
  let healthy = 0;
  let low = 0;
  let out = 0;

  for (const p of products) {
    const sell = Number(p.sellPrice);
    const qty = Number(p.stockQuantity);

    if (p.trackType === 'BATCH') {
      // Batch value = remaining share of each batch's purchase cost (WAREHOUSE + OPEN).
      // Never fall back to product.costPrice × stockQuantity (stale after SIMPLE→BATCH).
      const batchAgg = batchValueByProduct.get(p.id);
      if (batchAgg && batchAgg.qty > 0) {
        const avgCost = batchAgg.costSum / batchAgg.qty;
        totalValue += batchAgg.value;
        projectedProfit += (sell - avgCost) * batchAgg.qty;
      }
    } else {
      const cost = p.costPrice ? Number(p.costPrice) : 0;
      totalValue += cost * qty;
      projectedProfit += (sell - cost) * qty;
    }

    if (!p.trackStock) {
      healthy++;
      continue;
    }
    const level = stockLevelForProduct(
      p,
      p.trackType === 'BATCH' ? batchCounts.get(p.id) : undefined,
    );
    if (level === 'out') out++;
    else if (level === 'low') low++;
    else healthy++;
  }

  return {
    totalProducts: products.length,
    healthyCount: healthy,
    lowStockCount: low,
    outOfStockCount: out,
    inventoryValue: formatDisplayDecimal(totalValue, 2),
    projectedProfit: formatDisplayDecimal(projectedProfit, 2),
  };
}

export async function getProductByBarcode(tenantId: string, barcode: string) {
  const product = await prisma.product.findFirst({
    where: { tenantId, barcode, deletedAt: null, isActive: true },
    include: {
      category: { select: { id: true, name: true } },
      part: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
  });
  if (!product) throw new NotFoundError('Product not found');
  return serializeProductWithBatchCount(tenantId, product);
}

async function assertBatchSellPrice(
  trackType: string | undefined,
  batchSellPrice: number | null | undefined,
) {
  if (trackType !== 'BATCH') return;
  if (batchSellPrice == null || batchSellPrice < 0) {
    throw new ValidationError('Whole batch price is required for batch products');
  }
}

/** Ensures partId is null or belongs to this tenant (blocks cross-tenant linkage). */
async function assertShopPartOwned(tenantId: string, partId: string | null | undefined) {
  if (partId == null) return;
  const part = await prisma.shopPart.findFirst({
    where: { id: partId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!part) throw new NotFoundError('Shop part not found');
}

export async function createProduct(tenantId: string, input: z.infer<typeof productSchema>) {
  const name = input.name.trim();
  await assertUniqueCompactName('products', tenantId, name, 'product');
  await assertBatchSellPrice(input.trackType, input.batchSellPrice ?? null);
  await assertShopPartOwned(tenantId, input.partId);

  const product = await prisma.$transaction(async (tx) => {
    const trackType = input.trackType ?? 'SIMPLE';
    const created = await tx.product.create({
      data: {
        tenantId,
        name,
        categoryId: input.categoryId ?? null,
        partId: input.partId ?? null,
        brandId: input.brandId ?? null,
        supplierId: input.supplierId ?? null,
        sku: input.sku ?? null,
        barcode: input.barcode ?? null,
        imageUrl: input.imageUrl ?? null,
        unit: input.unit ?? 'piece',
        costPrice: input.costPrice != null ? toDecimal(input.costPrice) : null,
        sellPrice: toDecimal(input.sellPrice),
        batchSellPrice:
          trackType === 'BATCH' ? toDecimal(input.batchSellPrice!) : null,
        taxRate: toDecimal(input.taxRate ?? 0),
        lowStockThreshold:
          input.lowStockThreshold != null ? toDecimal(input.lowStockThreshold) : null,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
        trackStock: input.trackStock ?? true,
        trackType,
        dispensingLossPercent: toDecimal(input.dispensingLossPercent ?? 0),
        isActive: input.isActive ?? true,
      },
      include: {
        category: { select: { id: true, name: true } },
        part: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    await syncInsert(tx, SYNC_TABLES.products, created);
    return created;
  });
  return serializeProductWithBatchCount(tenantId, product);
}

export async function updateProduct(
  tenantId: string,
  id: string,
  input: Partial<z.infer<typeof productSchema>>,
) {
  const existing = await prisma.product.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!existing) throw new NotFoundError('Product not found');

  const name = input.name?.trim();
  if (name) {
    await assertUniqueCompactName('products', tenantId, name, 'product', id);
  }

  const nextTrackType = input.trackType ?? existing.trackType;
  const convertingToBatch =
    existing.trackType !== 'BATCH' && nextTrackType === 'BATCH';
  const convertingToSimple =
    existing.trackType === 'BATCH' && nextTrackType === 'SIMPLE';

  await assertBatchSellPrice(
    nextTrackType,
    input.batchSellPrice !== undefined
      ? input.batchSellPrice
      : existing.batchSellPrice?.toNumber() ?? null,
  );
  if (input.partId !== undefined) {
    await assertShopPartOwned(tenantId, input.partId);
  }

  if (convertingToSimple) {
    const activeBatches = await prisma.batch.count({
      where: {
        tenantId,
        productId: id,
        status: { in: ['WAREHOUSE', 'OPEN'] },
        remainingQuantity: { gt: 0 },
      },
    });
    if (activeBatches > 0) {
      throw new ValidationError(
        'Close or finish all warehouse/open batches before switching this product to simple tracking',
      );
    }
  }

  const product = await prisma.$transaction(async (tx) => {
    let costPriceUpdate:
      | ReturnType<typeof toDecimal>
      | null
      | undefined = undefined;
    if (convertingToBatch) {
      costPriceUpdate = null;
    } else if (input.costPrice !== undefined) {
      costPriceUpdate = input.costPrice == null ? null : toDecimal(input.costPrice);
    }

    const updated = await tx.product.update({
      where: { id },
      data: {
        name,
        categoryId: input.categoryId,
        partId: input.partId,
        brandId: input.brandId,
        supplierId: input.supplierId,
        sku: input.sku,
        barcode: input.barcode,
        imageUrl: input.imageUrl,
        unit: input.unit,
        costPrice: costPriceUpdate,
        ...(convertingToBatch ? { stockQuantity: toDecimal(0) } : {}),
        sellPrice: input.sellPrice != null ? toDecimal(input.sellPrice) : undefined,
        batchSellPrice:
          input.batchSellPrice !== undefined
            ? input.batchSellPrice != null
              ? toDecimal(input.batchSellPrice)
              : null
            : undefined,
        taxRate: input.taxRate != null ? toDecimal(input.taxRate) : undefined,
        lowStockThreshold:
          input.lowStockThreshold != null ? toDecimal(input.lowStockThreshold) : undefined,
        expiryDate:
          input.expiryDate !== undefined
            ? input.expiryDate
              ? new Date(input.expiryDate)
              : null
            : undefined,
        trackStock: input.trackStock,
        trackType: input.trackType,
        dispensingLossPercent:
          input.dispensingLossPercent != null ? toDecimal(input.dispensingLossPercent) : undefined,
        isActive: input.isActive,
      },
      include: {
        category: { select: { id: true, name: true } },
        part: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    await syncUpdate(tx, SYNC_TABLES.products, updated);
    if (input.partId !== undefined && input.partId !== existing.partId) {
      await backfillSaleItemsPartId(tx, tenantId, [id], input.partId ?? null);
    }
    return updated;
  });
  return serializeProductWithBatchCount(tenantId, product);
}

export async function adjustStock(
  tenantId: string,
  productId: string,
  input: z.infer<typeof stockAdjustSchema>,
  recordedById: string,
) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    if (!product) throw new NotFoundError('Product not found');
    if (product.trackType === 'BATCH') {
      throw new ValidationError(
        'Batch-tracked products use Receive batch for stock in, or Adjust on a batch for reconciliation.',
      );
    }

    const delta = toDecimal(input.quantityDelta);
    const newQty = product.stockQuantity.plus(delta);
    if (newQty.lt(0)) throw new NotFoundError('Stock cannot go negative');

    const updatedProduct = await tx.product.update({
      where: { id: productId },
      data: { stockQuantity: newQty },
    });

    const movement = await tx.stockMovement.create({
      data: {
        tenantId,
        productId,
        movementType: input.movementType,
        quantityDelta: delta,
        quantityAfter: newQty,
        referenceType: 'manual',
        notes: input.notes,
        recordedById,
      },
    });

    await syncUpdate(tx, SYNC_TABLES.products, updatedProduct);
    await syncInsert(tx, SYNC_TABLES.stockMovements, movement);

    return { productId, stockQuantity: formatDisplayDecimal(newQty, 2) };
  });
}

export async function deleteProduct(tenantId: string, id: string) {
  const existing = await prisma.product.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!existing) throw new NotFoundError('Product not found');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await syncUpdate(tx, SYNC_TABLES.products, updated);
    return { success: true };
  });
}

export async function getMiscOpenProduct(tenantId: string) {
  const product = await ensureMiscProduct(tenantId);
  return serializeProduct(product);
}

function serializeProduct(
  p: {
    id: string;
    name: string;
    sku: string | null;
    barcode: string | null;
    imageUrl: string | null;
    unit: string;
    costPrice?: Parameters<typeof formatDisplayDecimal>[0] | null;
    sellPrice: Parameters<typeof formatDisplayDecimal>[0];
    batchSellPrice?: Parameters<typeof formatDisplayDecimal>[0] | null;
    stockQuantity: Parameters<typeof formatDisplayDecimal>[0];
    lowStockThreshold: Parameters<typeof formatDisplayDecimal>[0] | null;
    taxRate: Parameters<typeof formatDisplayDecimal>[0];
    expiryDate?: Date | null;
    trackStock: boolean;
    trackType?: string;
    dispensingLossPercent?: Parameters<typeof formatDisplayDecimal>[0] | null;
    isActive: boolean;
    category: { id: string; name: string } | null;
    part?: { id: string; name: string } | null;
    brand?: { id: string; name: string } | null;
    supplier?: { id: string; name: string } | null;
  },
  batchCounts?: BatchStockCounts,
) {
  const isBatch = p.trackType === 'BATCH';
  const counts = batchCounts ?? { warehouse: 0, open: 0, total: 0 };
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    imageUrl: p.imageUrl,
    unit: p.unit,
    costPrice: p.costPrice != null ? formatDisplayDecimal(p.costPrice, 2) : null,
    sellPrice: formatDisplayDecimal(p.sellPrice, 2),
    batchSellPrice: isBatch
      ? formatDisplayDecimal(p.batchSellPrice ?? p.sellPrice, 2)
      : null,
    stockQuantity: formatDisplayDecimal(p.stockQuantity, 2),
    batchStockCount: isBatch ? counts.total : null,
    batchWarehouseCount: isBatch ? counts.warehouse : null,
    batchOpenCount: isBatch ? counts.open : null,
    lowStockThreshold:
      p.lowStockThreshold != null ? formatDisplayDecimal(p.lowStockThreshold, 2) : null,
    taxRate: formatDisplayDecimal(p.taxRate, 2),
    expiryDate: p.expiryDate?.toISOString().slice(0, 10) ?? null,
    trackStock: p.trackStock,
    trackType: (p.trackType === 'BATCH' ? 'BATCH' : 'SIMPLE') as 'SIMPLE' | 'BATCH',
    dispensingLossPercent: formatDisplayDecimal(p.dispensingLossPercent ?? 0, 2),
    isActive: p.isActive,
    category: p.category,
    part: p.part ?? null,
    brand: p.brand ?? null,
    supplier: p.supplier ?? null,
  };
}

function buildNameIdMap(items: Array<{ id: string; name: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(compactText(item.name), item.id);
  }
  return map;
}

export async function importProducts(
  tenantId: string,
  input: z.infer<typeof importProductsSchema>,
) {
  const [categories, parts, brands, suppliers, existingProducts] = await Promise.all([
    prisma.category.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.shopPart.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.supplier.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.product.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, sku: true, barcode: true },
    }),
  ]);

  const categoryByName = buildNameIdMap(categories);
  const partByName = buildNameIdMap(parts);
  const brandByName = buildNameIdMap(brands);
  const supplierByName = buildNameIdMap(suppliers);
  const byBarcode = new Map<string, string>();
  const bySku = new Map<string, string>();
  for (const p of existingProducts) {
    if (p.barcode) byBarcode.set(p.barcode.trim().toLowerCase(), p.id);
    if (p.sku) bySku.set(p.sku.trim().toLowerCase(), p.id);
  }

  const resolveName = (map: Map<string, string>, name: string | null | undefined) => {
    if (!name?.trim()) return null;
    return map.get(compactText(name)) ?? null;
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ row: number; message: string }> = [];
  const maxErrors = 50;

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    try {
      const categoryId = resolveName(categoryByName, row.categoryName);
      const partId = resolveName(partByName, row.partName);
      const brandId = resolveName(brandByName, row.brandName);
      const supplierId = resolveName(supplierByName, row.supplierName);

      const barcodeKey = row.barcode?.trim().toLowerCase();
      const skuKey = row.sku?.trim().toLowerCase();
      const existingId =
        (barcodeKey ? byBarcode.get(barcodeKey) : undefined) ??
        (skuKey ? bySku.get(skuKey) : undefined);

      if (existingId) {
        if (!input.updateExisting) {
          skipped++;
          continue;
        }
        await updateProduct(tenantId, existingId, {
          name: row.name,
          sellPrice: row.sellPrice,
          costPrice: row.costPrice ?? null,
          sku: row.sku ?? null,
          barcode: row.barcode ?? null,
          unit: row.unit ?? 'pcs',
          categoryId,
          partId,
          brandId,
          supplierId,
          lowStockThreshold: row.lowStockThreshold ?? null,
          trackStock: row.trackStock ?? true,
          expiryDate: row.expiryDate ?? null,
        });
        if (row.stockQuantity != null) {
          await prisma.product.update({
            where: { id: existingId },
            data: { stockQuantity: toDecimal(row.stockQuantity) },
          });
        }
        // Keep lookup maps current if sku/barcode changed.
        if (barcodeKey) byBarcode.set(barcodeKey, existingId);
        if (skuKey) bySku.set(skuKey, existingId);
        updated++;
        continue;
      }

      const createdProduct = await createProduct(tenantId, {
        name: row.name,
        sellPrice: row.sellPrice,
        costPrice: row.costPrice ?? null,
        sku: row.sku ?? null,
        barcode: row.barcode ?? null,
        unit: row.unit ?? 'pcs',
        categoryId,
        brandId,
        supplierId,
        lowStockThreshold: row.lowStockThreshold ?? null,
        trackStock: row.trackStock ?? true,
        expiryDate: row.expiryDate ?? null,
      });

      if (row.stockQuantity != null && row.stockQuantity > 0) {
        await prisma.product.update({
          where: { id: createdProduct.id },
          data: { stockQuantity: toDecimal(row.stockQuantity) },
        });
      }
      if (barcodeKey) byBarcode.set(barcodeKey, createdProduct.id);
      if (skuKey) bySku.set(skuKey, createdProduct.id);
      created++;
    } catch (err) {
      if (errors.length < maxErrors) {
        errors.push({
          row: i + 1,
          message: err instanceof Error ? err.message : 'Import failed',
        });
      }
    }
  }

  return { created, updated, skipped, errors, total: input.rows.length };
}

export async function purgeAllProducts(tenantId: string) {
  const products = await prisma.product.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true },
  });

  if (products.length === 0) {
    return { deleted: 0 };
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const product of products) {
      const updated = await tx.product.update({
        where: { id: product.id },
        data: { deletedAt: now, isActive: false },
      });
      await syncUpdate(tx, SYNC_TABLES.products, updated);
    }
  });

  return { deleted: products.length };
}
