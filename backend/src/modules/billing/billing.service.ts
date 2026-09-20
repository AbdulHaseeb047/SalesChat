import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { BRAND } from '../../constants/index.js';

import { writeAuditLog } from '../audit/audit.service.js';
import { resolvePkDateRange } from '../core/date-bounds.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.js';
import { prisma } from '../core/prisma.js';
import { toDecimal, formatDisplayDecimal } from '../core/money.js';
import { compactText, findIdsByCompactSearch } from '../core/text-match.js';
import { calculateSaleLine, calculateSaleTotals } from './billing.totals.js';
import { nextSaleNumber } from './sale-sequence.js';
import { recordCreditSale } from '../customers/ledger.service.js';
import { recordDiscountUsages } from './discounts.service.js';
import { getSettings } from '../settings/settings.service.js';
import { lockCustomerForUpdate } from '../customers/customer-lock.js';
import { decrementProductStock, incrementProductStock } from '../inventory/product-stock.js';
import {
  allocateLooseBatchSale,
  allocateWholeBatchSale,
  applyBatchAllocations,
  isWholeBatchSaleLine,
  restoreBatchQuantity,
  roundQtySold,
  stockQtyRemoved,
  stockQtyToRestore,
} from '../inventory/batch-sale.js';
import { SYNC_TABLES, syncInsert, syncOutboxEnabled, syncUpdate } from '../sync/sync-payload.js';

export const saleItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
  discountAmount: z.number().nonnegative().optional(),
  /** Display name override (e.g. miscellaneous / open amount description). */
  productName: z.string().min(1).max(255).optional(),
  /** Preferred batch for track_type=BATCH products. */
  batchId: z.string().uuid().optional().nullable(),
  /** WHOLE = sell entire warehouse batch; LOOSE = partial from counter batch. */
  saleMode: z.enum(['LOOSE', 'WHOLE']).optional(),
});

export const createSaleSchema = z.object({
  customerId: z.string().uuid().optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'SPLIT']),
  cashAmount: z.number().nonnegative().optional(),
  creditAmount: z.number().nonnegative().optional(),
  items: z.array(saleItemSchema).min(1),
  billDiscountAmount: z.number().nonnegative().optional(),
  appliedDiscounts: z
    .array(z.object({ ruleId: z.string().uuid(), amount: z.number().nonnegative() }))
    .optional(),
  notes: z.string().optional(),
  printReceipt: z.boolean().optional(),
  amountReceived: z.number().nonnegative().optional(),
  /** Credit from a prior return/exchange — reduces cash due on this sale. */
  exchangeCreditAmount: z.number().nonnegative().optional(),
  /** When true, split a batch line across multiple open batches if needed. */
  allowSplitBatches: z.boolean().optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export async function createSale(
  tenantId: string,
  cashierId: string,
  input: CreateSaleInput,
  options?: {
    canDiscountUnlimited?: boolean;
    maxDiscountPercent?: number | null;
    branchId?: string;
  },
) {
  if (input.paymentMethod === 'CREDIT' && !input.customerId) {
    throw new ValidationError('Customer is required for credit sales');
  }
  if (input.paymentMethod === 'SPLIT') {
    if (!input.customerId) throw new ValidationError('Customer is required for split payment');
    const cash = input.cashAmount ?? 0;
    const credit = input.creditAmount ?? 0;
    if (cash <= 0 && credit <= 0)
      throw new ValidationError('Split payment requires cash or credit amount');
  }

  const productIds = input.items.map((i) => i.productId);
  const saleId = randomUUID();
  const needsCustomer = Boolean(input.customerId);

  const [products, settings, customerRow] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, deletedAt: null, isActive: true },
    }),
    getSettings(tenantId),
    needsCustomer
      ? prisma.customer.findFirst({
          where: { id: input.customerId!, tenantId, deletedAt: null },
          select: { id: true, creditLimit: true, balance: true },
        })
      : Promise.resolve(null),
  ]);

  if (products.length !== productIds.length) {
    throw new NotFoundError('One or more products not found');
  }

  if (needsCustomer && !customerRow) {
    throw new NotFoundError('Customer not found');
  }

  const productMap = new Map(products.map((p) => [p.id, p]));

  const totals = calculateSaleTotals(
    input.items.map((item) => {
      const product = productMap.get(item.productId)!;
      const isBatch = String(product.trackType) === 'BATCH';
      const saleMode = item.saleMode ?? (isBatch ? 'LOOSE' : undefined);
      const defaultUnitPrice =
        isBatch && saleMode === 'WHOLE'
          ? product.batchSellPrice ?? product.sellPrice
          : product.sellPrice;
      const billedQty =
        isBatch && saleMode === 'WHOLE' ? toDecimal(1) : roundQtySold(item.quantity);
      return {
        unitPrice: item.unitPrice ?? defaultUnitPrice,
        quantity: billedQty,
        discountAmount: item.discountAmount ?? 0,
        taxRatePercent: product.taxRate,
      };
    }),
    input.billDiscountAmount ?? 0,
  );

  if (
    !options?.canDiscountUnlimited &&
    options?.maxDiscountPercent != null &&
    totals.discountTotal.gt(0)
  ) {
    const maxAllowed = totals.subtotal.times(options.maxDiscountPercent).div(100);
    if (totals.discountTotal.gt(maxAllowed)) {
      throw new ForbiddenError(
        `Discount exceeds allowed maximum of ${options.maxDiscountPercent}%`,
      );
    }
  }

  const { subtotal, discountTotal, taxTotal, grandTotal } = totals;

  const exchangeCreditRaw = toDecimal(input.exchangeCreditAmount ?? 0);
  if (exchangeCreditRaw.gt(0) && input.paymentMethod !== 'CASH') {
    throw new ValidationError('Exchange credit can only be applied on cash sales');
  }
  const exchangeCreditApplied = exchangeCreditRaw.gt(grandTotal) ? grandTotal : exchangeCreditRaw;
  const unusedExchangeRefund = exchangeCreditRaw.minus(exchangeCreditApplied);
  const cashDueAfterExchange = grandTotal.minus(exchangeCreditApplied);
  /** Actual cash that enters the drawer for this sale (0 when fully covered by exchange). */
  const cashCollected =
    exchangeCreditApplied.gt(0) && input.paymentMethod === 'CASH'
      ? cashDueAfterExchange
      : grandTotal;

  let amountReceived: ReturnType<typeof toDecimal> | null = null;
  let changeGiven: ReturnType<typeof toDecimal> | null = null;

  if (input.paymentMethod === 'CASH') {
    if (input.amountReceived == null) {
      throw new ValidationError('Amount received is required for cash sales');
    }
    amountReceived = toDecimal(input.amountReceived);
    if (amountReceived.lt(cashDueAfterExchange)) {
      throw new ValidationError(
        exchangeCreditApplied.gt(0)
          ? 'Amount received must cover the amount due after exchange credit'
          : 'Amount received must be at least the bill total',
      );
    }
    // Includes unused exchange credit that must be returned to the customer in cash.
    changeGiven = amountReceived.minus(cashDueAfterExchange).plus(unusedExchangeRefund);
  } else if (input.paymentMethod === 'SPLIT' && (input.cashAmount ?? 0) > 0) {
    if (input.amountReceived == null) {
      throw new ValidationError('Amount received is required for the cash portion');
    }
    const cashDue = toDecimal(input.cashAmount ?? 0);
    amountReceived = toDecimal(input.amountReceived);
    if (amountReceived.lt(cashDue)) {
      throw new ValidationError('Amount received must cover the cash portion');
    }
    changeGiven = amountReceived.minus(cashDue);
  }

  if (input.paymentMethod === 'SPLIT') {
    const cash = toDecimal(input.cashAmount ?? 0);
    const credit = toDecimal(input.creditAmount ?? 0);
    const sum = cash.plus(credit);
    if (!sum.eq(grandTotal)) {
      throw new ValidationError(
        `Split amounts (${sum.toFixed(2)}) must equal grand total (${grandTotal.toFixed(2)})`,
      );
    }
  }

  const lineItems = input.items.map((item, index) => {
    const product = productMap.get(item.productId)!;
    const calc = totals.lines[index]!;
    const customName = item.productName?.trim();
    const isBatch = String(product.trackType) === 'BATCH';
    const saleMode = item.saleMode ?? (isBatch ? 'LOOSE' : undefined);
    const quantitySold =
      isBatch && saleMode === 'WHOLE' ? toDecimal(1) : roundQtySold(item.quantity);
    const defaultUnitPrice =
      isBatch && saleMode === 'WHOLE'
        ? product.batchSellPrice ?? product.sellPrice
        : product.sellPrice;
    return {
      productId: product.id,
      productName: customName || product.name,
      unitPrice: toDecimal(item.unitPrice ?? defaultUnitPrice),
      quantity: quantitySold,
      discountAmount: calc.discountAmount,
      taxAmount: calc.taxAmount,
      lineTotal: calc.lineTotal,
      trackStock: product.trackStock,
      trackType: product.trackType,
      costPrice: product.costPrice,
      unit: product.unit,
      preferredBatchId: item.batchId ?? null,
      saleMode,
      inputDiscount: toDecimal(item.discountAmount ?? 0),
      taxRate: product.taxRate,
    };
  });

  const paymentStatus =
    input.paymentMethod === 'CREDIT'
      ? ('ON_CREDIT' as const)
      : input.paymentMethod === 'SPLIT' && (input.creditAmount ?? 0) > 0
        ? ('PARTIAL' as const)
        : ('PAID' as const);

  const creditAmt =
    input.paymentMethod === 'CREDIT'
      ? grandTotal
      : input.paymentMethod === 'SPLIT'
        ? toDecimal(input.creditAmount ?? 0)
        : toDecimal(0);
  const syncOn = syncOutboxEnabled();

  const saleInclude = {
    items: true,
    payments: true,
    customer: { select: { id: true, name: true, phone: true } },
    cashier: { select: { id: true, fullName: true } },
  } as const;

  // Fast path: nest payments when no credit ledger; batch stock movements; skip sync reloads on cloud.
  const sale = await prisma.$transaction(async (tx) => {
    const saleNumber = await nextSaleNumber(tx, tenantId);

    let invoiceNo: string | null = null;
    let qrData: string | null = null;
    if (settings.fbrEnabled && settings.fbrPosId) {
      invoiceNo = `${settings.fbrPosId}-${saleNumber}`;
      qrData = [
        'FBR',
        settings.fbrPosId,
        settings.fbrStrn ?? '',
        invoiceNo,
        new Date().toISOString(),
        grandTotal.toFixed(2),
        taxTotal.toFixed(2),
      ].join('|');
    }

    const nestPayments = creditAmt.lte(0);
    const nestedPaymentData =
      input.paymentMethod === 'SPLIT'
        ? [
            ...((input.cashAmount ?? 0) > 0
              ? [
                  {
                    tenantId,
                    paymentMethod: 'CASH' as const,
                    amount: toDecimal(input.cashAmount ?? 0),
                  },
                ]
              : []),
          ]
        : exchangeCreditApplied.gt(0)
          ? cashCollected.gt(0)
            ? [{ tenantId, paymentMethod: 'CASH' as const, amount: cashCollected }]
            : []
          : [{ tenantId, paymentMethod: input.paymentMethod, amount: grandTotal }];

    const exchangeParts: string[] = [];
    if (exchangeCreditApplied.gt(0)) {
      exchangeParts.push(`Exchange credit applied: ${exchangeCreditApplied.toFixed(2)}`);
    }
    if (unusedExchangeRefund.gt(0)) {
      exchangeParts.push(`Cash refund to customer: ${unusedExchangeRefund.toFixed(2)}`);
    }
    const exchangeNote = exchangeParts.length > 0 ? exchangeParts.join(' · ') : null;
    const saleNotes = [input.notes?.trim(), exchangeNote].filter(Boolean).join(' · ') || null;

    const closeTolRow = await tx.businessSettings.findUnique({
      where: { tenantId },
      select: { batchCloseTolerance: true },
    });
    const closeTolerance = closeTolRow?.batchCloseTolerance ?? toDecimal(0.1);
    const allowSplit = input.allowSplitBatches === true;

    type SaleItemCreate = {
      tenantId: string;
      productId: string;
      productName: string;
      unitPrice: ReturnType<typeof toDecimal>;
      quantity: ReturnType<typeof toDecimal>;
      quantityDeducted: ReturnType<typeof toDecimal>;
      unitCostAtSale: ReturnType<typeof toDecimal> | null;
      partId: string | null;
      batchId: string | null;
      discountAmount: ReturnType<typeof toDecimal>;
      taxAmount: ReturnType<typeof toDecimal>;
      lineTotal: ReturnType<typeof toDecimal>;
    };

    const saleItemCreates: SaleItemCreate[] = [];
    const pendingBatchApplies: Array<{
      productId: string;
      productName: string;
      unit: string;
      allocations: Awaited<ReturnType<typeof allocateLooseBatchSale>>;
    }> = [];
    const pendingSimple: Array<{
      productId: string;
      productName: string;
      quantity: ReturnType<typeof toDecimal>;
    }> = [];

    for (const li of lineItems) {
      const product = productMap.get(li.productId)!;
      const isBatch = String(li.trackType) === 'BATCH';
      if (li.preferredBatchId && !isBatch) {
        throw new ValidationError(
          `${li.productName} is not a batch-tracked product; remove batch selection or set track type to Batch.`,
        );
      }
      if (isBatch) {
        if (!li.trackStock) {
          throw new ValidationError(
            `${li.productName} is batch-tracked but stock tracking is off. Enable Track stock to sell from batches.`,
          );
        }
        const saleMode = li.saleMode ?? 'LOOSE';
        if (saleMode !== 'LOOSE' && saleMode !== 'WHOLE') {
          throw new ValidationError(`${li.productName}: choose loose or whole batch sale mode`);
        }
        const allocations =
          saleMode === 'WHOLE'
            ? await allocateWholeBatchSale(tx, {
                tenantId,
                product,
                preferredBatchId: li.preferredBatchId,
                closeTolerance,
              })
            : await allocateLooseBatchSale(tx, {
                tenantId,
                product,
                quantitySold: li.quantity,
                preferredBatchId: li.preferredBatchId,
                allowSplit,
                closeTolerance,
              });
        pendingBatchApplies.push({
          productId: li.productId,
          productName: li.productName,
          unit: li.unit,
          allocations,
        });

        const totalSold = allocations.reduce((s, a) => s.plus(a.quantitySold), toDecimal(0));
        let discountLeft = li.inputDiscount;
        for (let i = 0; i < allocations.length; i++) {
          const alloc = allocations[i]!;
          const isLast = i === allocations.length - 1;
          const disc = isLast
            ? discountLeft
            : totalSold.gt(0)
              ? li.inputDiscount.times(alloc.quantitySold).div(totalSold).toDecimalPlaces(2)
              : toDecimal(0);
          discountLeft = discountLeft.minus(disc);
          const calc = calculateSaleLine({
            unitPrice: li.unitPrice,
            quantity: alloc.quantitySold,
            discountAmount: disc,
            taxRatePercent: li.taxRate,
          });
          saleItemCreates.push({
            tenantId,
            productId: li.productId,
            productName: li.productName,
            unitPrice: li.unitPrice,
            quantity: alloc.quantitySold,
            quantityDeducted: alloc.quantityDeducted,
            unitCostAtSale: alloc.unitCostAtSale,
            partId: product.partId ?? null,
            batchId: alloc.batchId,
            discountAmount: calc.discountAmount,
            taxAmount: calc.taxAmount,
            lineTotal: calc.lineTotal,
          });
        }
      } else {
        saleItemCreates.push({
          tenantId,
          productId: li.productId,
          productName: li.productName,
          unitPrice: li.unitPrice,
          quantity: li.quantity,
          quantityDeducted: li.quantity,
          unitCostAtSale: li.costPrice,
          partId: product.partId ?? null,
          batchId: null,
          discountAmount: li.discountAmount,
          taxAmount: li.taxAmount,
          lineTotal: li.lineTotal,
        });
        if (li.trackStock) {
          pendingSimple.push({
            productId: li.productId,
            productName: li.productName,
            quantity: li.quantity,
          });
        }
      }
    }

    let created = await tx.sale.create({
      data: {
        id: saleId,
        tenantId,
        saleNumber,
        status: 'COMPLETED',
        customerId: input.customerId,
        subtotal,
        discountTotal,
        taxTotal,
        grandTotal,
        paymentStatus,
        notes: saleNotes,
        cashierId,
        branchId: options?.branchId,
        fbrInvoiceNumber: invoiceNo,
        fbrQrData: qrData,
        amountReceived,
        changeGiven,
        items: {
          create: saleItemCreates,
        },
        ...(nestPayments && nestedPaymentData.length > 0
          ? { payments: { create: nestedPaymentData } }
          : {}),
      },
      include: saleInclude,
    });

    let ledgerEntryId: string | null = null;
    if (creditAmt.gt(0) && input.customerId) {
      ledgerEntryId = await recordCreditSale(tx, {
        tenantId,
        customerId: input.customerId,
        saleId: created.id,
        amount: creditAmt,
        recordedById: cashierId,
      });

      const paymentRows: Array<{
        tenantId: string;
        saleId: string;
        paymentMethod: 'CASH' | 'CREDIT' | 'CARD' | 'BANK_TRANSFER';
        amount: ReturnType<typeof toDecimal>;
        ledgerEntryId?: string | null;
      }> = [];
      if (input.paymentMethod === 'SPLIT') {
        const cashAmt = toDecimal(input.cashAmount ?? 0);
        if (cashAmt.gt(0)) {
          paymentRows.push({
            tenantId,
            saleId: created.id,
            paymentMethod: 'CASH',
            amount: cashAmt,
          });
        }
        paymentRows.push({
          tenantId,
          saleId: created.id,
          paymentMethod: 'CREDIT',
          amount: creditAmt,
          ledgerEntryId,
        });
      } else {
        paymentRows.push({
          tenantId,
          saleId: created.id,
          paymentMethod: input.paymentMethod,
          amount: grandTotal,
          ledgerEntryId,
        });
      }
      await tx.salePayment.createMany({ data: paymentRows });
      created = (await tx.sale.findUnique({
        where: { id: created.id },
        include: saleInclude,
      }))!;
    }

    if (syncOn) {
      await syncInsert(tx, SYNC_TABLES.sales, created);
      for (const item of created.items) {
        await syncInsert(tx, SYNC_TABLES.saleItems, item);
      }
      for (const pay of created.payments) {
        await syncInsert(tx, SYNC_TABLES.salePayments, pay);
      }
    }

    if (input.appliedDiscounts?.length) {
      await recordDiscountUsages(tx, tenantId, created.id, input.appliedDiscounts);
    }

    const movementRows: Array<{
      tenantId: string;
      productId: string;
      batchId?: string | null;
      movementType: 'SALE' | 'ADJUSTMENT';
      quantityDelta: ReturnType<typeof toDecimal>;
      quantityAfter: ReturnType<typeof toDecimal>;
      referenceType: string;
      referenceId: string;
      notes?: string | null;
      recordedById: string;
      branchId?: string;
    }> = [];

    for (const simple of pendingSimple) {
      const quantityAfter = await decrementProductStock(tx, {
        tenantId,
        productId: simple.productId,
        quantity: simple.quantity,
        productName: simple.productName,
      });
      movementRows.push({
        tenantId,
        productId: simple.productId,
        movementType: 'SALE',
        quantityDelta: simple.quantity.negated(),
        quantityAfter,
        referenceType: 'sale',
        referenceId: created.id,
        recordedById: cashierId,
        branchId: options?.branchId,
      });
    }

    for (const pending of pendingBatchApplies) {
      const applied = await applyBatchAllocations(tx, {
        tenantId,
        productId: pending.productId,
        productName: pending.productName,
        unit: pending.unit,
        allocations: pending.allocations,
        saleId: created.id,
        recordedById: cashierId,
        branchId: options?.branchId,
      });
      for (const m of applied.movements) {
        movementRows.push({
          ...m,
          quantityAfter: applied.productStockAfter,
        });
      }
    }

    if (movementRows.length > 0) {
      await tx.stockMovement.createMany({ data: movementRows });
    }

    if (syncOn && movementRows.length > 0) {
      const movements = await tx.stockMovement.findMany({
        where: { tenantId, referenceId: created.id },
      });
      for (const movement of movements) {
        await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
      }
      const touchedProductIds = new Set([
        ...pendingSimple.map((p) => p.productId),
        ...pendingBatchApplies.map((p) => p.productId),
      ]);
      for (const productId of touchedProductIds) {
        const productRow = await tx.product.findUnique({ where: { id: productId } });
        if (productRow) await syncUpdate(tx, SYNC_TABLES.products, productRow);
      }
    }

    return created;
  });

  let creditLimitWarning: string | undefined;
  if (creditAmt.gt(0) && customerRow?.creditLimit) {
    const newBalance = customerRow.balance.plus(creditAmt);
    if (newBalance.gt(customerRow.creditLimit)) {
      creditLimitWarning = `Customer balance (${newBalance.toFixed(2)}) exceeds credit limit (${customerRow.creditLimit.toFixed(2)})`;
    }
  }

  const detail = {
    id: sale.id,
    saleNumber: sale.saleNumber,
    status: sale.status,
    subtotal: formatDisplayDecimal(sale.subtotal, 2),
    discountTotal: formatDisplayDecimal(sale.discountTotal, 2),
    taxTotal: formatDisplayDecimal(sale.taxTotal, 2),
    grandTotal: formatDisplayDecimal(sale.grandTotal, 2),
    amountReceived:
      sale.amountReceived != null ? formatDisplayDecimal(sale.amountReceived, 2) : null,
    changeGiven: sale.changeGiven != null ? formatDisplayDecimal(sale.changeGiven, 2) : null,
    paymentStatus: sale.paymentStatus,
    notes: sale.notes,
    createdAt: sale.createdAt.toISOString(),
    voidedAt: sale.voidedAt?.toISOString() ?? null,
    voidReason: sale.voidReason,
    fbrInvoiceNumber: sale.fbrInvoiceNumber,
    fbrQrData: sale.fbrQrData,
    customer: sale.customer,
    cashier: sale.cashier,
    items: sale.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      unitPrice: formatDisplayDecimal(i.unitPrice, 2),
      quantity: formatDisplayDecimal(i.quantity, 2),
      discountAmount: formatDisplayDecimal(i.discountAmount, 2),
      taxAmount: formatDisplayDecimal(i.taxAmount, 2),
      lineTotal: formatDisplayDecimal(i.lineTotal, 2),
      returnedQuantity: '0',
      returnableQuantity: formatDisplayDecimal(i.quantity, 2),
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      paymentMethod: p.paymentMethod,
      amount: formatDisplayDecimal(p.amount, 2),
    })),
    returns: [] as Array<{
      id: string;
      returnNumber: string;
      reason: string;
      totalAmount: string;
      createdAt: string;
      items: Array<{
        id: string;
        saleItemId: string;
        productName: string;
        quantity: string;
        refundAmount: string;
      }>;
    }>,
    receipt: {
      businessName: settings.businessName ?? 'POS',
      address: settings.address ?? null,
      phone: settings.phone ?? null,
      logoUrl: settings.logoUrl ?? null,
      receiptHeaderMode: settings.receiptHeaderMode ?? 'NAME',
      taxLabel: settings.taxLabel ?? 'Tax',
      receiptFooter: settings.receiptFooter ?? null,
      currency: settings.currency ?? 'PKR',
      fbrEnabled: settings.fbrEnabled ?? false,
      fbrPosId: settings.fbrPosId ?? null,
      fbrStrn: settings.fbrStrn ?? null,
      fbrRegisteredName: settings.fbrRegisteredName ?? null,
      builtBy: BRAND.builtBy,
    },
  };

  return {
    sale: {
      id: sale.id,
      saleNumber: sale.saleNumber,
      grandTotal: sale.grandTotal.toFixed(2),
      paymentStatus: sale.paymentStatus,
      createdAt: sale.createdAt.toISOString(),
    },
    detail,
    printReceipt: input.printReceipt ?? false,
    creditLimitWarning,
  };
}

export async function voidSale(
  tenantId: string,
  saleId: string,
  voidedById: string,
  voidReason: string,
  ipAddress?: string,
) {
  await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, tenantId },
      include: { items: true, payments: true, returns: { select: { id: true } } },
    });

    if (!sale) throw new NotFoundError('Sale not found');
    if (sale.status === 'VOIDED') throw new ConflictError('Sale already voided');
    if (sale.returns.length > 0) {
      throw new ConflictError(
        'Cannot void a sale that already has returns — stock was already restored on return',
        'SALE_HAS_RETURNS',
      );
    }

    const voidedSale = await tx.sale.update({
      where: { id: saleId },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedById,
        voidReason,
      },
    });
    await syncUpdate(tx, SYNC_TABLES.sales, voidedSale);

    for (const item of sale.items) {
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product?.trackStock) continue;

      // Restore actual meters/kg removed (WHOLE coil ≠ billed qty 1).
      const restoreQty = stockQtyRemoved(item);

      if (item.batchId && product.trackType === 'BATCH') {
        await restoreBatchQuantity(tx, {
          tenantId,
          batchId: item.batchId,
          restoreQty,
          reopenAs: isWholeBatchSaleLine(item) ? 'WAREHOUSE' : 'OPEN',
        });
      }

      const quantityAfter = await incrementProductStock(tx, {
        tenantId,
        productId: product.id,
        quantity: restoreQty,
      });

      const movement = await tx.stockMovement.create({
        data: {
          tenantId,
          productId: product.id,
          batchId: item.batchId,
          movementType: 'RETURN',
          quantityDelta: restoreQty,
          quantityAfter,
          referenceType: 'sale_void',
          referenceId: saleId,
          notes: voidReason,
          recordedById: voidedById,
          branchId: sale.branchId,
        },
      });

      const productRow = await tx.product.findUnique({ where: { id: product.id } });
      await syncInsert(tx, SYNC_TABLES.stockMovements, movement);
      if (productRow) {
        await syncUpdate(tx, SYNC_TABLES.products, productRow);
      }
    }

    const creditPayment = sale.payments.find((p) => p.paymentMethod === 'CREDIT');
    if (creditPayment && sale.customerId) {
      await lockCustomerForUpdate(tx, tenantId, sale.customerId);

      const ledgerEntry = await tx.customerLedgerEntry.findFirst({
        where: { saleId, entryType: 'CREDIT_SALE', voidedAt: null },
      });

      if (ledgerEntry) {
        const voidedEntry = await tx.customerLedgerEntry.update({
          where: { id: ledgerEntry.id },
          data: { voidedAt: new Date(), voidedById, voidReason },
        });

        const reversalBalance = ledgerEntry.balanceAfter.minus(ledgerEntry.amount);
        const reversal = await tx.customerLedgerEntry.create({
          data: {
            tenantId,
            customerId: sale.customerId,
            entryType: 'VOID_REVERSAL',
            amount: ledgerEntry.amount.negated(),
            balanceAfter: reversalBalance,
            saleId,
            recordedById: voidedById,
            reversalOfId: ledgerEntry.id,
            notes: voidReason,
          },
        });

        const obligations = await tx.customerCreditObligation.findMany({ where: { saleId } });
        for (const obligation of obligations) {
          const updatedObligation = await tx.customerCreditObligation.update({
            where: { id: obligation.id },
            data: { remainingAmount: 0, closedAt: new Date() },
          });
          await syncUpdate(tx, SYNC_TABLES.customerCreditObligations, updatedObligation);
        }

        await syncUpdate(tx, SYNC_TABLES.customerLedgerEntries, voidedEntry);
        await syncInsert(tx, SYNC_TABLES.customerLedgerEntries, reversal);

        await tx.customer.update({
          where: { id: sale.customerId },
          data: { balance: reversalBalance },
        });
      }
    }

    await writeAuditLog({
      tenantId,
      userId: voidedById,
      action: 'sale.voided',
      entityType: 'sale',
      entityId: saleId,
      metadata: { voidReason },
      ipAddress,
    });
  });

  return { success: true };
}

export async function getSaleDetail(tenantId: string, saleId: string) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, tenantId },
    include: {
      items: true,
      payments: true,
      customer: { select: { id: true, name: true, phone: true } },
      cashier: { select: { id: true, fullName: true } },
      returns: { include: { items: true } },
    },
  });
  if (!sale) throw new NotFoundError('Sale not found');

  const settings = await getSettings(tenantId);

  const returnedByItem = new Map<string, number>();
  for (const ret of sale.returns) {
    for (const ri of ret.items) {
      const prev = returnedByItem.get(ri.saleItemId) ?? 0;
      returnedByItem.set(ri.saleItemId, prev + Number(ri.quantity));
    }
  }

  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    status: sale.status,
    subtotal: formatDisplayDecimal(sale.subtotal, 2),
    discountTotal: formatDisplayDecimal(sale.discountTotal, 2),
    taxTotal: formatDisplayDecimal(sale.taxTotal, 2),
    grandTotal: formatDisplayDecimal(sale.grandTotal, 2),
    amountReceived:
      sale.amountReceived != null ? formatDisplayDecimal(sale.amountReceived, 2) : null,
    changeGiven: sale.changeGiven != null ? formatDisplayDecimal(sale.changeGiven, 2) : null,
    paymentStatus: sale.paymentStatus,
    notes: sale.notes,
    createdAt: sale.createdAt.toISOString(),
    voidedAt: sale.voidedAt?.toISOString() ?? null,
    voidReason: sale.voidReason,
    fbrInvoiceNumber: sale.fbrInvoiceNumber,
    fbrQrData: sale.fbrQrData,
    customer: sale.customer,
    cashier: sale.cashier,
    items: sale.items.map((i) => {
      const sold = Number(i.quantity);
      const returnedQuantity = returnedByItem.get(i.id) ?? 0;
      const returnableQuantity = Math.max(0, sold - returnedQuantity);
      return {
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        unitPrice: formatDisplayDecimal(i.unitPrice, 2),
        quantity: formatDisplayDecimal(i.quantity, 2),
        discountAmount: formatDisplayDecimal(i.discountAmount, 2),
        taxAmount: formatDisplayDecimal(i.taxAmount, 2),
        lineTotal: formatDisplayDecimal(i.lineTotal, 2),
        returnedQuantity: formatDisplayDecimal(returnedQuantity, 2),
        returnableQuantity: formatDisplayDecimal(returnableQuantity, 2),
      };
    }),
    payments: sale.payments.map((p) => ({
      id: p.id,
      paymentMethod: p.paymentMethod,
      amount: formatDisplayDecimal(p.amount, 2),
    })),
    returns: sale.returns.map((r) => ({
      id: r.id,
      returnNumber: r.returnNumber,
      reason: r.reason,
      totalAmount: formatDisplayDecimal(r.totalAmount, 2),
      createdAt: r.createdAt.toISOString(),
      items: r.items.map((ri) => ({
        id: ri.id,
        saleItemId: ri.saleItemId,
        productName: ri.productName,
        quantity: formatDisplayDecimal(ri.quantity, 2),
        refundAmount: formatDisplayDecimal(ri.refundAmount, 2),
      })),
    })),
    receipt: {
      businessName: settings?.businessName ?? 'POS',
      address: settings?.address ?? null,
      phone: settings?.phone ?? null,
      logoUrl: settings?.logoUrl ?? null,
      receiptHeaderMode: settings?.receiptHeaderMode ?? 'NAME',
      taxLabel: settings?.taxLabel ?? 'Tax',
      receiptFooter: settings?.receiptFooter ?? null,
      currency: settings?.currency ?? 'PKR',
      fbrEnabled: settings?.fbrEnabled ?? false,
      fbrPosId: settings?.fbrPosId ?? null,
      fbrStrn: settings?.fbrStrn ?? null,
      fbrRegisteredName: settings?.fbrRegisteredName ?? null,
      builtBy: BRAND.builtBy,
    },
  };
}

export const partialReturnSchema = z.object({
  reason: z.string().min(1),
  items: z
    .array(
      z.object({
        saleItemId: z.string().uuid(),
        quantity: z.number().positive(),
      }),
    )
    .min(1),
});

export async function partialReturn(
  tenantId: string,
  saleId: string,
  processedById: string,
  input: z.infer<typeof partialReturnSchema>,
) {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, tenantId, status: 'COMPLETED' },
      include: {
        items: true,
        returns: { include: { items: true } },
      },
    });
    if (!sale) throw new NotFoundError('Sale not found or not eligible for return');

    const alreadyReturned = new Map<string, ReturnType<typeof toDecimal>>();
    for (const ret of sale.returns) {
      for (const ri of ret.items) {
        const prev = alreadyReturned.get(ri.saleItemId) ?? toDecimal(0);
        alreadyReturned.set(ri.saleItemId, prev.plus(ri.quantity));
      }
    }

    const returnCount = await tx.saleReturn.count({ where: { tenantId } });
    const returnNumber = `RET-${String(returnCount + 1).padStart(5, '0')}`;

    let totalRefund = toDecimal(0);
    const returnItems: Array<{
      saleItemId: string;
      productId: string;
      productName: string;
      quantity: ReturnType<typeof toDecimal>;
      refundAmount: ReturnType<typeof toDecimal>;
    }> = [];

    for (const req of input.items) {
      const saleItem = sale.items.find((i) => i.id === req.saleItemId);
      if (!saleItem) throw new NotFoundError(`Sale item ${req.saleItemId} not found`);
      const qty = toDecimal(req.quantity);
      const prior = alreadyReturned.get(saleItem.id) ?? toDecimal(0);
      const returnable = saleItem.quantity.minus(prior);
      if (qty.gt(returnable)) {
        throw new ValidationError(
          `Return quantity exceeds remaining returnable qty for ${saleItem.productName} (sold ${saleItem.quantity.toFixed(3)}, already returned ${prior.toFixed(3)}, returnable ${returnable.toFixed(3)})`,
        );
      }
      if (saleItem.quantity.lte(0)) {
        throw new ValidationError(`Invalid sold quantity for ${saleItem.productName}`);
      }
      const unitRefund = saleItem.lineTotal.div(saleItem.quantity);
      const refundAmount = unitRefund.times(qty);
      totalRefund = totalRefund.plus(refundAmount);
      returnItems.push({
        saleItemId: saleItem.id,
        productId: saleItem.productId,
        productName: saleItem.productName,
        quantity: qty,
        refundAmount,
      });
    }

    const saleReturn = await tx.saleReturn.create({
      data: {
        tenantId,
        saleId,
        returnNumber,
        reason: input.reason,
        totalAmount: totalRefund,
        processedById,
        items: {
          create: returnItems.map((ri) => ({
            tenantId,
            saleItemId: ri.saleItemId,
            productId: ri.productId,
            productName: ri.productName,
            quantity: ri.quantity,
            refundAmount: ri.refundAmount,
          })),
        },
      },
      include: { items: true },
    });

    for (const ri of returnItems) {
      const product = await tx.product.findUnique({ where: { id: ri.productId } });
      if (!product?.trackStock) continue;

      const saleItem = sale.items.find((i) => i.id === ri.saleItemId)!;
      const restoreQty = stockQtyToRestore({
        billedQuantity: saleItem.quantity,
        quantityDeducted: saleItem.quantityDeducted,
        returnQty: ri.quantity,
      });

      if (saleItem.batchId && product.trackType === 'BATCH') {
        await restoreBatchQuantity(tx, {
          tenantId,
          batchId: saleItem.batchId,
          restoreQty,
          reopenAs: isWholeBatchSaleLine(saleItem) ? 'WAREHOUSE' : 'OPEN',
        });
      }

      const quantityAfter = await incrementProductStock(tx, {
        tenantId,
        productId: product.id,
        quantity: restoreQty,
      });

      await tx.stockMovement.create({
        data: {
          tenantId,
          productId: product.id,
          batchId: saleItem.batchId,
          movementType: 'RETURN',
          quantityDelta: restoreQty,
          quantityAfter,
          referenceType: 'sale_return',
          referenceId: saleReturn.id,
          notes: input.reason,
          recordedById: processedById,
          branchId: sale.branchId,
        },
      });
    }

    return {
      id: saleReturn.id,
      returnNumber: saleReturn.returnNumber,
      totalAmount: saleReturn.totalAmount.toFixed(2),
      items: saleReturn.items.map((i) => ({
        productName: i.productName,
        quantity: i.quantity.toFixed(3),
        refundAmount: i.refundAmount.toFixed(2),
      })),
    };
  });
}

function dateRangeBounds(from?: string, to?: string): { gte: Date; lte: Date } | undefined {
  if (!from && !to) return undefined;
  const { start, end } = resolvePkDateRange(from, to);
  return { gte: start, lte: end };
}

export async function listSales(
  tenantId: string,
  page = 1,
  pageSize = 20,
  branchId?: string,
  search?: string,
  from?: string,
  to?: string,
) {
  const skip = (page - 1) * pageSize;
  const term = search?.trim();
  const createdAt = dateRangeBounds(from, to);
  const compact = term ? compactText(term) : '';
  const statusMatches = term
    ? (['PAID', 'ON_CREDIT', 'PARTIAL'] as const).filter(
        (s) =>
          s.toLowerCase().includes(term.toLowerCase()) ||
          (compact.includes('credit') && s === 'ON_CREDIT') ||
          (compact.includes('udhaar') && s === 'ON_CREDIT') ||
          s.toLowerCase().replace(/_/g, '').includes(compact),
      )
    : [];

  const customerIds = term
    ? await findIdsByCompactSearch('customers', tenantId, term, ['phone'], null)
    : null;

  const saleNumberFilters =
    term && compact
      ? Array.from(new Set([term, compact])).map((value) => ({
          saleNumber: { contains: value, mode: 'insensitive' as const },
        }))
      : [];

  const searchOr = term
    ? [
        ...saleNumberFilters,
        ...(customerIds && customerIds.length > 0 ? [{ customerId: { in: customerIds } }] : []),
        ...(statusMatches.length > 0 ? [{ paymentStatus: { in: [...statusMatches] } }] : []),
      ]
    : [];

  if (term && searchOr.length === 0) {
    return {
      data: [],
      meta: { total: 0, page, pageSize, totalPages: 0 },
    };
  }

  const where = {
    tenantId,
    status: 'COMPLETED' as const,
    ...(branchId ? { branchId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(term ? { OR: searchOr } : {}),
  };
  const [data, total] = await prisma.$transaction([
    prisma.sale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: {
        id: true,
        saleNumber: true,
        status: true,
        subtotal: true,
        discountTotal: true,
        taxTotal: true,
        grandTotal: true,
        paymentStatus: true,
        createdAt: true,
        customer: { select: { id: true, name: true, phone: true } },
        cashier: { select: { id: true, fullName: true } },
        payments: { select: { paymentMethod: true, amount: true } },
        _count: { select: { items: true } },
        returns: { select: { totalAmount: true } },
      },
    }),
    prisma.sale.count({ where }),
  ]);

  return {
    data: data.map((s) => {
      const returnedTotal = s.returns.reduce((sum, r) => sum + Number(r.totalAmount), 0);
      return {
        id: s.id,
        saleNumber: s.saleNumber,
        status: s.status,
        subtotal: formatDisplayDecimal(s.subtotal, 2),
        discountTotal: formatDisplayDecimal(s.discountTotal, 2),
        taxTotal: formatDisplayDecimal(s.taxTotal, 2),
        grandTotal: formatDisplayDecimal(s.grandTotal, 2),
        paymentStatus: s.paymentStatus,
        createdAt: s.createdAt.toISOString(),
        customer: s.customer,
        cashier: s.cashier,
        itemCount: s._count.items,
        payments: s.payments.map((p) => ({
          paymentMethod: p.paymentMethod,
          amount: formatDisplayDecimal(p.amount, 2),
        })),
        hasReturns: s.returns.length > 0,
        returnedTotal: formatDisplayDecimal(returnedTotal, 2),
        netTotal: formatDisplayDecimal(Math.max(0, Number(s.grandTotal) - returnedTotal), 2),
      };
    }),
    meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
  };
}
