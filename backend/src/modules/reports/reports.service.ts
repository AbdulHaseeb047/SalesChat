import { Decimal } from '@prisma/client/runtime/library';

import { pkDayKey, resolvePkDateRange, startOfPkDay, endOfPkDay } from '../core/date-bounds.js';
import { formatDisplayDecimal } from '../core/money.js';
import { prisma } from '../core/prisma.js';
import { getUdhaarAging } from '../customers/ledger.service.js';
import { allocateRevenueByLineShare } from './revenue-allocate.js';

const PK_TZ = 'Asia/Karachi';

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Credit Card',
  BANK_TRANSFER: 'Mobile Wallet',
  CREDIT: 'Udhaar / Credit',
  SPLIT: 'Split',
};

const PAYMENT_COLORS: Record<string, string> = {
  CASH: '#059669',
  CARD: '#0284c7',
  BANK_TRANSFER: '#7c3aed',
  CREDIT: '#ea580c',
  SPLIT: '#64748b',
};

function changePct(today: number, yesterday: number): number {
  if (yesterday <= 0) return today > 0 ? 100 : 0;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function dayKeyInPk(d: Date): string {
  return pkDayKey(d);
}

function shortDayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' });
}

export async function getDashboardSummary(
  tenantId: string,
  branchId?: string,
  from?: string,
  to?: string,
) {
  const now = new Date();
  const { start, end, fromIso, toIso, isSingleDay } = resolvePkDateRange(from, to, now);

  const durationMs = Math.max(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000 - 1);
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  const saleWherePeriod = {
    tenantId,
    status: 'COMPLETED' as const,
    createdAt: { gte: start, lte: end },
    ...(branchId ? { branchId } : {}),
  };
  const saleWherePrev = {
    tenantId,
    status: 'COMPLETED' as const,
    createdAt: { gte: prevStart, lte: prevEnd },
    ...(branchId ? { branchId } : {}),
  };

  const [
    periodSalesAgg,
    periodCount,
    prevSalesAgg,
    prevCount,
    lowStockRows,
    lowStockCountRow,
    inventoryValueRow,
    productCount,
    udhaarTotal,
    periodReturns,
    returnItemsAgg,
    prevReturns,
    periodSalesDetail,
  ] = await Promise.all([
    prisma.sale.aggregate({ where: saleWherePeriod, _sum: { grandTotal: true } }),
    prisma.sale.count({ where: saleWherePeriod }),
    prisma.sale.aggregate({ where: saleWherePrev, _sum: { grandTotal: true } }),
    prisma.sale.count({ where: saleWherePrev }),
    prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        stock_quantity: { toString(): string } | string | number;
        low_stock_threshold: { toString(): string } | string | number;
      }>
    >`
      SELECT p.id, p.name,
        CASE
          WHEN p.track_type = 'BATCH' THEN COALESCE(bc.cnt, 0)::numeric
          ELSE p.stock_quantity
        END AS stock_quantity,
        p.low_stock_threshold
      FROM products p
      LEFT JOIN (
        SELECT product_id, COUNT(*)::int AS cnt
        FROM batches
        WHERE tenant_id = ${tenantId}::uuid
          AND status IN ('WAREHOUSE', 'OPEN')
          AND remaining_quantity > 0
        GROUP BY product_id
      ) bc ON bc.product_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid
        AND p.deleted_at IS NULL
        AND p.is_active = true
        AND p.track_stock = true
        AND p.low_stock_threshold IS NOT NULL
        AND (
          CASE
            WHEN p.track_type = 'BATCH' THEN COALESCE(bc.cnt, 0)
            ELSE p.stock_quantity
          END
        ) > 0
        AND (
          CASE
            WHEN p.track_type = 'BATCH' THEN COALESCE(bc.cnt, 0)
            ELSE p.stock_quantity
          END
        ) <= p.low_stock_threshold
      ORDER BY stock_quantity ASC, p.name ASC
      LIMIT 5
    `,
    prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*)::int AS count
      FROM products p
      LEFT JOIN (
        SELECT product_id, COUNT(*)::int AS cnt
        FROM batches
        WHERE tenant_id = ${tenantId}::uuid
          AND status IN ('WAREHOUSE', 'OPEN')
          AND remaining_quantity > 0
        GROUP BY product_id
      ) bc ON bc.product_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid
        AND p.deleted_at IS NULL
        AND p.is_active = true
        AND p.track_stock = true
        AND p.low_stock_threshold IS NOT NULL
        AND (
          CASE
            WHEN p.track_type = 'BATCH' THEN COALESCE(bc.cnt, 0)
            ELSE p.stock_quantity
          END
        ) > 0
        AND (
          CASE
            WHEN p.track_type = 'BATCH' THEN COALESCE(bc.cnt, 0)
            ELSE p.stock_quantity
          END
        ) <= p.low_stock_threshold
    `,
    prisma.$queryRaw<Array<{ value: { toString(): string } | string | number | null }>>`
      SELECT (
        COALESCE((
          SELECT SUM(b.remaining_quantity * b.cost_per_unit)
          FROM batches b
          INNER JOIN products p ON p.id = b.product_id
          WHERE b.tenant_id = ${tenantId}::uuid
            AND b.status IN ('WAREHOUSE', 'OPEN')
            AND b.remaining_quantity > 0
            AND p.deleted_at IS NULL
            AND p.is_active = true
            AND p.track_type = 'BATCH'
        ), 0)
        +
        COALESCE((
          SELECT SUM(COALESCE(p.cost_price, 0) * p.stock_quantity)
          FROM products p
          WHERE p.tenant_id = ${tenantId}::uuid
            AND p.deleted_at IS NULL
            AND p.is_active = true
            AND p.track_type = 'SIMPLE'
        ), 0)
      ) AS value
    `,
    prisma.product.count({
      where: { tenantId, deletedAt: null, isActive: true },
    }),
    prisma.customer.aggregate({
      where: { tenantId, deletedAt: null, balance: { gt: 0 } },
      _sum: { balance: true },
    }),
    prisma.saleReturn.aggregate({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      _sum: { totalAmount: true },
      _count: true,
    }),
    prisma.saleReturnItem.aggregate({
      where: {
        tenantId,
        saleReturn: {
          createdAt: { gte: start, lte: end },
          ...(branchId ? { sale: { branchId } } : {}),
        },
      },
      _sum: { quantity: true },
    }),
    prisma.saleReturn.aggregate({
      where: {
        tenantId,
        createdAt: { gte: prevStart, lte: prevEnd },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      _sum: { totalAmount: true },
    }),
    prisma.sale.findMany({
      where: saleWherePeriod,
      select: {
        createdAt: true,
        grandTotal: true,
        payments: { select: { paymentMethod: true, amount: true } },
        items: {
          select: {
            productId: true,
            productName: true,
            lineTotal: true,
            quantity: true,
            product: {
              select: {
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const lowStockAlerts = lowStockRows.map((p) => ({
    id: p.id,
    name: p.name,
    stockQuantity: formatDisplayDecimal(Number(p.stock_quantity), 2),
    lowStockThreshold: formatDisplayDecimal(Number(p.low_stock_threshold), 2),
  }));
  const lowStockCount = Number(lowStockCountRow[0]?.count ?? 0);
  const inventoryValue = formatDisplayDecimal(Number(inventoryValueRow[0]?.value ?? 0), 2);

  const grossSales = periodSalesAgg._sum.grandTotal ?? new Decimal(0);
  const returnsAmount = periodReturns._sum.totalAmount ?? new Decimal(0);
  const netSales = Decimal.max(0, grossSales.minus(returnsAmount));

  const yGross = prevSalesAgg._sum.grandTotal ?? new Decimal(0);
  const yReturns = prevReturns._sum.totalAmount ?? new Decimal(0);
  const yNet = Decimal.max(0, yGross.minus(yReturns));

  const periodRevenue = Number(netSales);
  const prevRevenue = Number(yNet);
  const periodAov = periodCount > 0 ? periodRevenue / periodCount : 0;
  const prevAov = prevCount > 0 ? prevRevenue / prevCount : 0;

  const paymentMap = new Map<string, number>();
  const productMap = new Map<string, { name: string; revenue: number; quantity: number }>();
  const categoryMap = new Map<string, { name: string; quantity: number; revenue: number }>();

  let hourlySales: Array<{ hour: string; revenue: number; transactions: number }> = [];

  const accumulateSaleItems = (
    items: Array<{
      productId: string;
      productName: string;
      lineTotal: { toString(): string } | number | string;
      quantity: { toString(): string } | number | string;
      product?: {
        categoryId: string | null;
        category: { id: string; name: string } | null;
      } | null;
    }>,
    saleGrandTotal: { toString(): string } | number | string,
  ) => {
    const allocated = allocateRevenueByLineShare(
      items.map((i) => i.lineTotal as never),
      saleGrandTotal as never,
    );
    items.forEach((item, index) => {
      const qty = Number(item.quantity);
      const revenue = Number(allocated[index] ?? 0);
      const existing = productMap.get(item.productId) ?? {
        name: item.productName,
        revenue: 0,
        quantity: 0,
      };
      existing.revenue += revenue;
      existing.quantity += qty;
      productMap.set(item.productId, existing);

      const cat = item.product?.category;
      if (cat) {
        const catRow = categoryMap.get(cat.id) ?? {
          name: cat.name,
          quantity: 0,
          revenue: 0,
        };
        catRow.quantity += qty;
        catRow.revenue += revenue;
        categoryMap.set(cat.id, catRow);
      }
    });
  };

  if (isSingleDay) {
    const hourlyMap = new Map<number, { revenue: number; transactions: number }>();
    for (let h = 8; h <= 22; h++) hourlyMap.set(h, { revenue: 0, transactions: 0 });

    for (const sale of periodSalesDetail) {
      const hourPart = new Intl.DateTimeFormat('en-US', {
        timeZone: PK_TZ,
        hour: 'numeric',
        hour12: false,
      })
        .formatToParts(sale.createdAt)
        .find((p) => p.type === 'hour')?.value;
      const hour = Number(hourPart === '24' ? '0' : hourPart) % 24;
      const bucket = hourlyMap.get(hour);
      if (bucket) {
        bucket.revenue += Number(sale.grandTotal);
        bucket.transactions += 1;
      }

      for (const p of sale.payments) {
        paymentMap.set(p.paymentMethod, (paymentMap.get(p.paymentMethod) ?? 0) + Number(p.amount));
      }
      accumulateSaleItems(sale.items, sale.grandTotal);
    }

    hourlySales = [...hourlyMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([hour, data]) => ({
        hour: hourLabel(hour),
        revenue: Math.round(data.revenue * 100) / 100,
        transactions: data.transactions,
      }));
  } else {
    const dailyMap = new Map<string, { revenue: number; transactions: number }>();
    for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
      dailyMap.set(dayKeyInPk(new Date(t)), { revenue: 0, transactions: 0 });
    }

    for (const sale of periodSalesDetail) {
      const key = dayKeyInPk(sale.createdAt);
      const bucket = dailyMap.get(key) ?? { revenue: 0, transactions: 0 };
      bucket.revenue += Number(sale.grandTotal);
      bucket.transactions += 1;
      dailyMap.set(key, bucket);

      for (const p of sale.payments) {
        paymentMap.set(p.paymentMethod, (paymentMap.get(p.paymentMethod) ?? 0) + Number(p.amount));
      }
      accumulateSaleItems(sale.items, sale.grandTotal);
    }

    hourlySales = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([iso, data]) => ({
        hour: shortDayLabel(iso),
        revenue: Math.round(data.revenue * 100) / 100,
        transactions: data.transactions,
      }));
  }

  const paymentTotal = [...paymentMap.values()].reduce((s, v) => s + v, 0);
  const paymentMethods =
    paymentTotal > 0
      ? [...paymentMap.entries()]
          .map(([method, amount]) => ({
            name: PAYMENT_LABELS[method] ?? method.replace(/_/g, ' '),
            value: Math.round((amount / paymentTotal) * 1000) / 10,
            amount: amount.toFixed(2),
            color: PAYMENT_COLORS[method] ?? '#64748b',
          }))
          .sort((a, b) => b.value - a.value)
      : [];

  const topProducts = [...productMap.entries()]
    .map(([, data]) => ({
      name: data.name,
      revenue: Math.round(data.revenue * 100) / 100,
      quantitySold: Math.round(data.quantity * 1000) / 1000,
    }))
    .sort((a, b) => b.quantitySold - a.quantitySold || b.revenue - a.revenue)
    .slice(0, 5);

  const topCategories = [...categoryMap.entries()]
    .map(([id, data]) => ({
      id,
      name: data.name,
      revenue: Math.round(data.revenue * 100) / 100,
      quantitySold: Math.round(data.quantity * 1000) / 1000,
    }))
    .sort((a, b) => b.quantitySold - a.quantitySold || b.revenue - a.revenue);

  return {
    from: fromIso,
    to: toIso,
    chartMode: isSingleDay ? ('hourly' as const) : ('daily' as const),
    compareLabel: isSingleDay ? 'vs yesterday' : 'vs prior period',
    todaySalesTotal: netSales.toFixed(2),
    todayGrossSalesTotal: grossSales.toFixed(2),
    todayTransactionCount: periodCount,
    averageOrderValue: periodAov.toFixed(2),
    revenueChangePct: changePct(periodRevenue, prevRevenue),
    aovChangePct: changePct(periodAov, prevAov),
    transactionChangePct: changePct(periodCount, prevCount),
    lowStockCount,
    lowStockAlerts,
    inventoryValue,
    totalProducts: productCount,
    outstandingUdhaar: formatDisplayDecimal(udhaarTotal._sum.balance ?? 0, 2),
    todayReturnsAmount: formatDisplayDecimal(returnsAmount, 2),
    todayReturnsCount: periodReturns._count,
    todayReturnedUnits: formatDisplayDecimal(returnItemsAgg._sum.quantity ?? 0, 2),
    hourlySales,
    paymentMethods,
    topProducts,
    topCategories,
  };
}

export async function getDailySalesReport(tenantId: string, date?: string, branchId?: string) {
  const dayKey = date?.trim() || pkDayKey(new Date());
  const day = startOfPkDay(dayKey);
  const dayEnd = endOfPkDay(dayKey);

  const [sales, returnsAgg] = await Promise.all([
    prisma.sale.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        createdAt: { gte: day, lte: dayEnd },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        saleNumber: true,
        grandTotal: true,
        paymentStatus: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
    }),
    prisma.saleReturn.aggregate({
      where: {
        tenantId,
        createdAt: { gte: day, lte: dayEnd },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      _sum: { totalAmount: true },
      _count: true,
    }),
  ]);

  const grossTotal = sales.reduce((sum, s) => sum.plus(s.grandTotal), new Decimal(0));
  const returnsAmount = returnsAgg._sum.totalAmount ?? new Decimal(0);
  const netTotal = Decimal.max(0, grossTotal.minus(returnsAmount));

  return {
    date: dayKey,
    total: netTotal.toFixed(2),
    grossTotal: grossTotal.toFixed(2),
    returnsTotal: returnsAmount.toFixed(2),
    returnsCount: returnsAgg._count,
    transactionCount: sales.length,
    sales: sales.map((s) => ({
      id: s.id,
      saleNumber: s.saleNumber,
      grandTotal: s.grandTotal.toFixed(2),
      paymentStatus: s.paymentStatus,
      customerName: s.customer?.name ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export async function getUdhaarAgingReport(tenantId: string) {
  return getUdhaarAging(tenantId);
}

export async function getSalesSummary(
  tenantId: string,
  from?: string,
  to?: string,
  branchId?: string,
) {
  const { start, end } = resolvePkDateRange(from, to);

  const saleWhere = {
    tenantId,
    status: 'COMPLETED' as const,
    createdAt: { gte: start, lte: end },
    ...(branchId ? { branchId } : {}),
  };

  const [sales, returns] = await Promise.all([
    prisma.sale.findMany({
      where: saleWhere,
      include: {
        items: {
          include: { product: { select: { costPrice: true } } },
        },
      },
    }),
    prisma.saleReturn.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      include: { items: true },
    }),
  ]);

  const gasLossAgg = await prisma.batch.aggregate({
    where: {
      tenantId,
      closedAt: { gte: start, lte: end },
      gasLossCost: { not: null },
    },
    _sum: { gasLossCost: true },
  });
  const gasLossCostTotal = gasLossAgg._sum.gasLossCost ?? new Decimal(0);

  const returnSaleItemIds = [...new Set(returns.flatMap((r) => r.items.map((i) => i.saleItemId)))];
  const returnSaleItems =
    returnSaleItemIds.length > 0
      ? await prisma.saleItem.findMany({
          where: { id: { in: returnSaleItemIds }, tenantId },
          select: {
            id: true,
            unitCostAtSale: true,
            product: { select: { costPrice: true } },
          },
        })
      : [];
  const returnCostBySaleItem = new Map(
    returnSaleItems.map((si) => [
      si.id,
      si.unitCostAtSale ?? si.product.costPrice ?? null,
    ]),
  );

  // Fallback for older returns / missing sale-item rows
  const returnProductIds = [...new Set(returns.flatMap((r) => r.items.map((i) => i.productId)))];
  const returnProducts =
    returnProductIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: returnProductIds }, tenantId },
          select: { id: true, costPrice: true },
        })
      : [];
  const returnCostMap = new Map(returnProducts.map((p) => [p.id, p.costPrice]));

  let grossRevenue = new Decimal(0);
  let cost = new Decimal(0);
  let tax = new Decimal(0);
  let discounts = new Decimal(0);
  let returnsAmount = new Decimal(0);
  let returnedCost = new Decimal(0);

  const productMap = new Map<string, { name: string; qty: number; revenue: number }>();

  for (const sale of sales) {
    grossRevenue = grossRevenue.plus(sale.grandTotal);
    tax = tax.plus(sale.taxTotal);
    discounts = discounts.plus(sale.discountTotal);

    const allocated = allocateRevenueByLineShare(
      sale.items.map((item) => item.lineTotal),
      sale.grandTotal,
    );

    sale.items.forEach((item, index) => {
      const unitCost = item.unitCostAtSale ?? item.product.costPrice;
      const qtyForCost = item.quantityDeducted ?? item.quantity;
      const itemCost = unitCost ? unitCost.times(qtyForCost) : new Decimal(0);
      cost = cost.plus(itemCost);

      const existing = productMap.get(item.productId) ?? {
        name: item.productName,
        qty: 0,
        revenue: 0,
      };
      existing.qty += Number(item.quantity);
      existing.revenue += Number(allocated[index] ?? 0);
      productMap.set(item.productId, existing);
    });
  }

  for (const ret of returns) {
    returnsAmount = returnsAmount.plus(ret.totalAmount);
    for (const ri of ret.items) {
      const unitCost =
        returnCostBySaleItem.get(ri.saleItemId) ?? returnCostMap.get(ri.productId) ?? null;
      const itemCost = unitCost ? unitCost.times(ri.quantity) : new Decimal(0);
      returnedCost = returnedCost.plus(itemCost);

      const existing = productMap.get(ri.productId);
      if (existing) {
        existing.qty = Math.max(0, existing.qty - Number(ri.quantity));
        existing.revenue = Math.max(0, existing.revenue - Number(ri.refundAmount));
      }
    }
  }

  const revenue = Decimal.max(0, grossRevenue.minus(returnsAmount));
  const netCost = Decimal.max(0, cost.minus(returnedCost).plus(gasLossCostTotal));
  const grossProfit = revenue.minus(netCost).minus(tax);

  const topProducts = [...productMap.entries()]
    .map(([productId, data]) => ({
      productId,
      name: data.name,
      quantitySold: data.qty,
      revenue: data.revenue.toFixed(2),
    }))
    .filter((p) => p.quantitySold > 0 || Number(p.revenue) > 0)
    .sort((a, b) => b.quantitySold - a.quantitySold || Number(b.revenue) - Number(a.revenue))
    .slice(0, 10);

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    transactionCount: sales.length,
    returnsCount: returns.length,
    grossRevenue: grossRevenue.toFixed(2),
    returnsAmount: returnsAmount.toFixed(2),
    revenue: revenue.toFixed(2),
    cost: netCost.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    taxTotal: tax.toFixed(2),
    discountTotal: discounts.toFixed(2),
    averageTicket: sales.length > 0 ? revenue.div(sales.length).toFixed(2) : '0.00',
    topProducts,
  };
}

const UNASSIGNED_PART_KEY = '__unassigned__';

function shopPartKey(partId: string | null | undefined): string {
  return partId ?? UNASSIGNED_PART_KEY;
}

type ShopPartAgg = {
  revenue: Decimal;
  cost: Decimal;
  tax: Decimal;
  returnsAmount: Decimal;
  returnedCost: Decimal;
  gasLossCost: Decimal;
  purchaseTotal: Decimal;
  saleIds: Set<string>;
};

function emptyShopPartAgg(): ShopPartAgg {
  return {
    revenue: new Decimal(0),
    cost: new Decimal(0),
    tax: new Decimal(0),
    returnsAmount: new Decimal(0),
    returnedCost: new Decimal(0),
    gasLossCost: new Decimal(0),
    purchaseTotal: new Decimal(0),
    saleIds: new Set<string>(),
  };
}

function finalizeShopPartRow(
  key: string,
  row: ShopPartAgg,
  nameByKey: Map<string, string>,
) {
  const netRevenue = Decimal.max(0, row.revenue.minus(row.returnsAmount));
  const netCost = Decimal.max(0, row.cost.minus(row.returnedCost).plus(row.gasLossCost));
  const grossProfit = netRevenue.minus(netCost).minus(row.tax);
  return {
    partId: key === UNASSIGNED_PART_KEY ? null : key,
    name: nameByKey.get(key) ?? 'Unknown',
    revenue: netRevenue.toFixed(2),
    cost: netCost.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    taxTotal: row.tax.toFixed(2),
    purchaseTotal: row.purchaseTotal.toFixed(2),
    transactionCount: row.saleIds.size,
  };
}

/** Per-part and combined sales/profit/purchase for shop divisions. */
export async function getShopPartsSummary(
  tenantId: string,
  from?: string,
  to?: string,
  branchId?: string,
  filterPartId?: string | null,
) {
  const { start, end } = resolvePkDateRange(from, to);

  const [parts, sales, returns, gasLossBatches, stockIns, batchPurchases] = await Promise.all([
    prisma.shopPart.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.sale.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
        ...(branchId ? { branchId } : {}),
      },
      include: {
        items: {
          select: {
            saleId: true,
            partId: true,
            lineTotal: true,
            taxAmount: true,
            quantity: true,
            quantityDeducted: true,
            unitCostAtSale: true,
            product: { select: { costPrice: true } },
          },
        },
      },
    }),
    prisma.saleReturn.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      include: { items: true },
    }),
    prisma.batch.findMany({
      where: {
        tenantId,
        closedAt: { gte: start, lte: end },
        gasLossCost: { not: null },
      },
      select: {
        gasLossCost: true,
        product: { select: { partId: true } },
      },
    }),
    prisma.stockMovement.findMany({
      where: {
        tenantId,
        movementType: 'STOCK_IN',
        batchId: null,
        createdAt: { gte: start, lte: end },
      },
      select: {
        quantityDelta: true,
        product: { select: { partId: true, costPrice: true } },
      },
    }),
    prisma.batch.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      select: {
        costPerUnit: true,
        initialQuantity: true,
        product: { select: { partId: true } },
      },
    }),
  ]);

  const returnSaleItemIds = [...new Set(returns.flatMap((r) => r.items.map((i) => i.saleItemId)))];
  const returnSaleItems =
    returnSaleItemIds.length > 0
      ? await prisma.saleItem.findMany({
          where: { id: { in: returnSaleItemIds }, tenantId },
          select: {
            id: true,
            partId: true,
            unitCostAtSale: true,
            product: { select: { costPrice: true } },
          },
        })
      : [];
  const returnItemById = new Map(returnSaleItems.map((si) => [si.id, si]));

  const aggs = new Map<string, ShopPartAgg>();
  const ensureAgg = (key: string): ShopPartAgg => {
    const existing = aggs.get(key);
    if (existing) return existing;
    const created = emptyShopPartAgg();
    aggs.set(key, created);
    return created;
  };

  for (const sale of sales) {
    const allocated = allocateRevenueByLineShare(
      sale.items.map((item) => item.lineTotal),
      sale.grandTotal,
    );
    sale.items.forEach((item, index) => {
      const key = shopPartKey(item.partId);
      const row = ensureAgg(key);
      row.revenue = row.revenue.plus(allocated[index] ?? 0);
      row.tax = row.tax.plus(item.taxAmount);
      const unitCost = item.unitCostAtSale ?? item.product.costPrice;
      const qtyForCost = item.quantityDeducted ?? item.quantity;
      const itemCost = unitCost ? unitCost.times(qtyForCost) : new Decimal(0);
      row.cost = row.cost.plus(itemCost);
      row.saleIds.add(sale.id);
    });
  }

  for (const ret of returns) {
    for (const ri of ret.items) {
      const si = returnItemById.get(ri.saleItemId);
      const key = shopPartKey(si?.partId);
      const row = ensureAgg(key);
      row.returnsAmount = row.returnsAmount.plus(ri.refundAmount);
      const unitCost = si?.unitCostAtSale ?? si?.product.costPrice ?? null;
      const itemCost = unitCost ? unitCost.times(ri.quantity) : new Decimal(0);
      row.returnedCost = row.returnedCost.plus(itemCost);
    }
  }

  for (const batch of gasLossBatches) {
    const key = shopPartKey(batch.product.partId);
    const row = ensureAgg(key);
    row.gasLossCost = row.gasLossCost.plus(batch.gasLossCost ?? 0);
  }

  for (const movement of stockIns) {
    const key = shopPartKey(movement.product.partId);
    const row = ensureAgg(key);
    const cost = movement.product.costPrice ?? new Decimal(0);
    row.purchaseTotal = row.purchaseTotal.plus(cost.times(movement.quantityDelta.abs()));
  }

  for (const batch of batchPurchases) {
    const key = shopPartKey(batch.product.partId);
    const row = ensureAgg(key);
    row.purchaseTotal = row.purchaseTotal.plus(batch.costPerUnit.times(batch.initialQuantity));
  }

  const nameByKey = new Map<string, string>([
    [UNASSIGNED_PART_KEY, 'Unassigned'],
    ...parts.map((p) => [p.id, p.name] as const),
  ]);

  const combinedAgg = emptyShopPartAgg();
  for (const row of aggs.values()) {
    combinedAgg.revenue = combinedAgg.revenue.plus(row.revenue);
    combinedAgg.cost = combinedAgg.cost.plus(row.cost);
    combinedAgg.tax = combinedAgg.tax.plus(row.tax);
    combinedAgg.returnsAmount = combinedAgg.returnsAmount.plus(row.returnsAmount);
    combinedAgg.returnedCost = combinedAgg.returnedCost.plus(row.returnedCost);
    combinedAgg.gasLossCost = combinedAgg.gasLossCost.plus(row.gasLossCost);
    combinedAgg.purchaseTotal = combinedAgg.purchaseTotal.plus(row.purchaseTotal);
    for (const saleId of row.saleIds) combinedAgg.saleIds.add(saleId);
  }

  const partRows = parts.map((part) =>
    finalizeShopPartRow(part.id, ensureAgg(part.id), nameByKey),
  );
  if (aggs.has(UNASSIGNED_PART_KEY)) {
    partRows.push(finalizeShopPartRow(UNASSIGNED_PART_KEY, ensureAgg(UNASSIGNED_PART_KEY), nameByKey));
  }

  const combined = finalizeShopPartRow('combined', combinedAgg, new Map([['combined', 'Combined']]));

  const filteredParts =
    filterPartId === UNASSIGNED_PART_KEY || filterPartId === 'none'
      ? partRows.filter((p) => p.partId == null)
      : filterPartId
        ? partRows.filter((p) => p.partId === filterPartId)
        : partRows;

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    combined: {
      partId: null,
      name: 'Combined',
      revenue: combined.revenue,
      cost: combined.cost,
      grossProfit: combined.grossProfit,
      taxTotal: combined.taxTotal,
      purchaseTotal: combined.purchaseTotal,
      transactionCount: combined.transactionCount,
    },
    parts: filteredParts,
  };
}

/** Daily series for dashboard mountain/area charts (default last 14 days). */
export async function getSalesTrend(tenantId: string, days = 14, branchId?: string) {
  const dayCount = Math.min(Math.max(days, 7), 90);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (dayCount - 1));

  const localDateKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const [sales, returns] = await Promise.all([
    prisma.sale.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
        ...(branchId ? { branchId } : {}),
      },
      select: { grandTotal: true, createdAt: true },
    }),
    prisma.saleReturn.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      select: { totalAmount: true, createdAt: true },
    }),
  ]);

  const byDay = new Map<string, { sales: number; transactions: number; returns: number }>();
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    byDay.set(localDateKey(d), { sales: 0, transactions: 0, returns: 0 });
  }

  for (const s of sales) {
    const row = byDay.get(localDateKey(s.createdAt));
    if (!row) continue;
    row.sales += Number(s.grandTotal);
    row.transactions += 1;
  }

  for (const r of returns) {
    const row = byDay.get(localDateKey(r.createdAt));
    if (!row) continue;
    row.returns += Number(r.totalAmount);
  }

  const series = [...byDay.entries()].map(([date, row]) => {
    const net = Math.max(0, row.sales - row.returns);
    return {
      date,
      sales: net.toFixed(2),
      grossSales: row.sales.toFixed(2),
      transactions: row.transactions,
      returns: row.returns.toFixed(2),
    };
  });

  const totalSales = series.reduce((sum, d) => sum + parseFloat(d.sales), 0);
  const totalGrossSales = series.reduce((sum, d) => sum + parseFloat(d.grossSales), 0);
  const totalTx = series.reduce((sum, d) => sum + d.transactions, 0);
  const totalReturns = series.reduce((sum, d) => sum + parseFloat(d.returns), 0);
  const mid = Math.floor(series.length / 2);
  const firstHalf = series.slice(0, mid).reduce((sum, d) => sum + parseFloat(d.sales), 0);
  const secondHalf = series.slice(mid).reduce((sum, d) => sum + parseFloat(d.sales), 0);
  const growthPct =
    firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : secondHalf > 0 ? 100 : 0;

  return {
    from: localDateKey(start),
    to: localDateKey(end),
    days: dayCount,
    totalSales: totalSales.toFixed(2),
    totalGrossSales: totalGrossSales.toFixed(2),
    totalTransactions: totalTx,
    totalReturns: totalReturns.toFixed(2),
    growthPct: Math.round(growthPct * 10) / 10,
    series,
  };
}

export async function getStockMovementReport(
  tenantId: string,
  from?: string,
  to?: string,
  limit = 100,
) {
  const { start, end } = resolvePkDateRange(from, to);
  const take = Math.min(Math.max(limit, 1), 1000);

  const movements = await prisma.stockMovement.findMany({
    where: { tenantId, createdAt: { gte: start, lte: end } },
    include: { product: { select: { name: true, sku: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return {
    movements: movements.map((m) => ({
      id: m.id,
      productName: m.product.name,
      movementType: m.movementType,
      quantityDelta: formatDisplayDecimal(m.quantityDelta, 2),
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function getStaffPerformanceReport(tenantId: string, from?: string, to?: string) {
  const { start, end } = resolvePkDateRange(from, to);

  const sales = await prisma.sale.groupBy({
    by: ['cashierId'],
    where: { tenantId, status: 'COMPLETED', createdAt: { gte: start, lte: end } },
    _count: { id: true },
    _sum: { grandTotal: true },
  });

  const cashiers = await prisma.user.findMany({
    where: { id: { in: sales.map((s) => s.cashierId) } },
    select: { id: true, fullName: true },
  });
  const nameMap = new Map(cashiers.map((c) => [c.id, c.fullName]));

  return sales.map((s) => ({
    cashierId: s.cashierId,
    cashierName: nameMap.get(s.cashierId) ?? 'Unknown',
    transactionCount: s._count.id,
    totalSales: s._sum.grandTotal?.toFixed(2) ?? '0.00',
  }));
}
