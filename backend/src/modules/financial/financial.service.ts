import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { resolvePkDateRange } from '../core/date-bounds.js';
import { NotFoundError } from '../core/errors.js';
import { prisma } from '../core/prisma.js';
import { formatDisplayDecimal, toDecimal } from '../core/money.js';
import {
  cashFlowForType,
  defaultCategoryForType,
  financialEntryTypes,
  summarizeCashBuckets,
} from './cash-flow.js';

export { financialEntryTypes };

export const financialEntrySchema = z.object({
  entryType: z.enum(financialEntryTypes),
  amount: z.number().positive(),
  category: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  occurredAt: z.string().datetime().optional(),
});

function serializeEntry(entry: {
  id: string;
  entryType: string;
  amount: Prisma.Decimal | number | string;
  category: string;
  description: string | null;
  occurredAt: Date;
  recordedById: string;
  voidedAt: Date | null;
  voidReason: string | null;
}) {
  return {
    id: entry.id,
    entryType: entry.entryType,
    amount: formatDisplayDecimal(entry.amount, 2),
    category: entry.category,
    description: entry.description,
    occurredAt: entry.occurredAt.toISOString(),
    recordedById: entry.recordedById,
    voidedAt: entry.voidedAt?.toISOString() ?? null,
    voidReason: entry.voidReason,
    flow: cashFlowForType(entry.entryType),
  };
}

export async function listFinancialEntries(tenantId: string, from?: string, to?: string) {
  const { start, end } = resolvePkDateRange(from, to);
  const bounds = { gte: start, lte: end };
  const [entries, stockMovements] = await Promise.all([
    prisma.financialEntry.findMany({
      where: { tenantId, occurredAt: bounds },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.stockMovement.findMany({
      where: { tenantId, movementType: 'STOCK_IN', createdAt: bounds },
      include: {
        product: { select: { name: true, unit: true, costPrice: true, sku: true } },
        batch: { select: { costPerUnit: true } },
      },
    }),
  ]);
  const manual = entries.map(serializeEntry);
  const stockIn = stockMovements.map((movement) => {
    const quantity = Number(movement.quantityDelta);
    const unitCost = Number(movement.batch?.costPerUnit ?? movement.product.costPrice ?? 0);
    return {
      id: movement.id,
      entryType: 'STOCK_IN',
      amount: formatDisplayDecimal(quantity * unitCost, 2),
      category: 'Stock received',
      description: `Received ${quantity} ${movement.product.unit} of ${movement.product.name}${movement.product.sku ? ` (${movement.product.sku})` : ''}`,
      occurredAt: movement.createdAt.toISOString(),
      recordedById: movement.recordedById,
      voidedAt: null,
      voidReason: null,
      flow: 'stock' as const,
    };
  });
  return [...manual, ...stockIn].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export async function createFinancialEntry(
  tenantId: string,
  recordedById: string,
  input: z.infer<typeof financialEntrySchema>,
) {
  const category = input.category?.trim() || defaultCategoryForType(input.entryType);
  const entry = await prisma.financialEntry.create({
    data: {
      tenantId,
      recordedById,
      entryType: input.entryType,
      amount: toDecimal(input.amount),
      category,
      description: input.description ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    },
  });
  return serializeEntry(entry);
}

export async function voidFinancialEntry(tenantId: string, id: string, reason: string) {
  const existing = await prisma.financialEntry.findFirst({
    where: { id, tenantId, voidedAt: null },
  });
  if (!existing) throw new NotFoundError('Financial entry not found');
  const entry = await prisma.financialEntry.update({
    where: { id },
    data: { voidedAt: new Date(), voidReason: reason.trim() || 'Voided' },
  });
  return serializeEntry(entry);
}

export async function getFinancialSummary(tenantId: string, from?: string, to?: string) {
  const { start, end, fromIso, toIso } = resolvePkDateRange(from, to);
  const bounds = { gte: start, lte: end };
  const [entries, salesCollected, customerCollections, supplierPayments, stockIns] =
    await Promise.all([
      prisma.financialEntry.findMany({
        where: { tenantId, voidedAt: null, occurredAt: bounds },
        select: { entryType: true, amount: true },
      }),
      prisma.salePayment.aggregate({
        where: {
          tenantId,
          paymentMethod: { not: 'CREDIT' },
          createdAt: bounds,
          sale: { status: 'COMPLETED' },
        },
        _sum: { amount: true },
      }),
      prisma.customerLedgerEntry.aggregate({
        where: { tenantId, entryType: 'PAYMENT', voidedAt: null, createdAt: bounds },
        _sum: { amount: true },
      }),
      prisma.supplierLedgerEntry.aggregate({
        where: { tenantId, entryType: 'PAYMENT', createdAt: bounds },
        _sum: { amount: true },
      }),
      prisma.stockMovement.findMany({
        where: { tenantId, movementType: 'STOCK_IN', createdAt: bounds },
        select: {
          quantityDelta: true,
          product: { select: { costPrice: true } },
          batch: { select: { costPerUnit: true } },
        },
      }),
    ]);

  const byType = new Map<string, number>();
  for (const entry of entries) {
    byType.set(entry.entryType, (byType.get(entry.entryType) ?? 0) + Number(entry.amount));
  }

  const stockBought = stockIns.reduce((total, movement) => {
    const unitCost = Number(movement.batch?.costPerUnit ?? movement.product.costPrice ?? 0);
    return total + Number(movement.quantityDelta) * unitCost;
  }, 0);

  const buckets = summarizeCashBuckets({
    byType,
    salesCollected: Number(salesCollected._sum.amount ?? 0),
    customerCollections: Math.abs(Number(customerCollections._sum.amount ?? 0)),
    supplierPayments: Math.abs(Number(supplierPayments._sum.amount ?? 0)),
    stockBought,
  });

  const money = (value: number) => formatDisplayDecimal(value, 2);
  const typeTotal = (type: string) => money(byType.get(type) ?? 0);

  return {
    from: fromIso,
    to: toIso,
    inflows: money(buckets.moneyIn),
    outflows: money(buckets.moneyOut),
    netMovement: money(buckets.cashLeft),
    moneyIn: money(buckets.moneyIn),
    moneyOut: money(buckets.moneyOut),
    cashLeft: money(buckets.cashLeft),
    manualInflows: money(buckets.ownerPutIn + buckets.otherIncome),
    manualOutflows: money(
      buckets.shopExpenses + buckets.ownerTookOut + buckets.refunds + buckets.cashStockPurchases,
    ),
    salesCollected: money(buckets.salesCollected),
    customerCollections: money(buckets.customerCollections),
    supplierPayments: money(buckets.supplierPayments),
    purchasesRecorded: money(buckets.stockBought),
    stockBought: money(buckets.stockBought),
    stillOweSuppliers: money(buckets.stillOweSuppliers),
    ownerPutIn: money(buckets.ownerPutIn),
    otherIncome: money(buckets.otherIncome),
    shopExpenses: money(buckets.shopExpenses),
    ownerTookOut: money(buckets.ownerTookOut),
    refunds: money(buckets.refunds),
    cashStockPurchases: money(buckets.cashStockPurchases),
    byType: Object.fromEntries([...byType.entries()].map(([key]) => [key, typeTotal(key)])),
  };
}
