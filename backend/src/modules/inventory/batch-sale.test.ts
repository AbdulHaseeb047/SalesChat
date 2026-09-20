import { Decimal } from '@prisma/client/runtime/library';
import { describe, expect, it } from 'vitest';

import {
  isWholeBatchSaleLine,
  planLooseAllocations,
  planWholeAllocation,
  roundQtySold,
  stockQtyRemoved,
  stockQtyToRestore,
} from './batch-sale.js';
import { toDecimal } from '../core/money.js';

describe('roundQtySold', () => {
  it('rounds half-up to 2 decimal places', () => {
    expect(roundQtySold(10.125).toFixed(2)).toBe('10.13');
    expect(roundQtySold(10.124).toFixed(2)).toBe('10.12');
    expect(roundQtySold(1.005).toFixed(2)).toBe('1.01');
  });
});

describe('planLooseAllocations', () => {
  const tol = toDecimal(0.1);

  it('deducts exact billed meters from one OPEN batch', () => {
    const allocs = planLooseAllocations({
      batches: [
        { id: 'b1', remainingQuantity: toDecimal(50), costPerUnit: toDecimal(100) },
      ],
      quantitySold: toDecimal(12.5),
      allowSplit: false,
      closeTolerance: tol,
      productName: 'Wire',
      unit: 'm',
    });

    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.quantitySold.toFixed(2)).toBe('12.50');
    expect(allocs[0]!.quantityDeducted.toFixed(3)).toBe('12.500');
    expect(allocs[0]!.remainingAfter.toFixed(3)).toBe('37.500');
    expect(allocs[0]!.closed).toBe(false);
    expect(allocs[0]!.sourceStatus).toBe('OPEN');
  });

  it('closes batch when leftover ≤ close tolerance', () => {
    const allocs = planLooseAllocations({
      batches: [{ id: 'b1', remainingQuantity: toDecimal(10.05), costPerUnit: toDecimal(10) }],
      quantitySold: toDecimal(10),
      allowSplit: false,
      closeTolerance: tol,
      productName: 'Gas',
      unit: 'kg',
    });

    expect(allocs[0]!.remainingAfter.toFixed(3)).toBe('0.000');
    expect(allocs[0]!.closed).toBe(true);
  });

  it('refuses split when allowSplit is false', () => {
    expect(() =>
      planLooseAllocations({
        batches: [
          { id: 'b1', remainingQuantity: toDecimal(5), costPerUnit: toDecimal(1) },
          { id: 'b2', remainingQuantity: toDecimal(10), costPerUnit: toDecimal(1) },
        ],
        quantitySold: toDecimal(8),
        allowSplit: false,
        closeTolerance: tol,
        productName: 'Wire',
        unit: 'm',
      }),
    ).toThrow(/BATCH_SPLIT_REQUIRED|split/i);
  });

  it('splits across OPEN batches FIFO when allowed', () => {
    const allocs = planLooseAllocations({
      batches: [
        { id: 'b1', remainingQuantity: toDecimal(5), costPerUnit: toDecimal(10) },
        { id: 'b2', remainingQuantity: toDecimal(10), costPerUnit: toDecimal(12) },
      ],
      quantitySold: toDecimal(8),
      allowSplit: true,
      closeTolerance: tol,
      productName: 'Wire',
      unit: 'm',
    });

    expect(allocs).toHaveLength(2);
    expect(allocs[0]!.batchId).toBe('b1');
    expect(allocs[0]!.quantityDeducted.toFixed(3)).toBe('5.000');
    expect(allocs[1]!.batchId).toBe('b2');
    expect(allocs[1]!.quantityDeducted.toFixed(3)).toBe('3.000');
    const total = allocs.reduce((s, a) => s.plus(a.quantityDeducted), toDecimal(0));
    expect(total.toFixed(3)).toBe('8.000');
  });

  it('rejects when total OPEN remaining is insufficient', () => {
    expect(() =>
      planLooseAllocations({
        batches: [{ id: 'b1', remainingQuantity: toDecimal(3), costPerUnit: toDecimal(1) }],
        quantitySold: toDecimal(5),
        allowSplit: true,
        closeTolerance: tol,
        productName: 'Wire',
        unit: 'm',
      }),
    ).toThrow(/INSUFFICIENT_BATCH_STOCK|Insufficient/i);
  });
});

describe('planWholeAllocation', () => {
  it('bills qty 1 but deducts full remaining meters', () => {
    const allocs = planWholeAllocation({
      batch: { id: 'coil-1', remainingQuantity: toDecimal(47.25), costPerUnit: toDecimal(80) },
      closeTolerance: toDecimal(0.1),
      unit: 'm',
    });

    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.quantitySold.toFixed(3)).toBe('1.000');
    expect(allocs[0]!.quantityDeducted.toFixed(3)).toBe('47.250');
    expect(allocs[0]!.remainingAfter.toFixed(3)).toBe('0.000');
    expect(allocs[0]!.closed).toBe(true);
    expect(allocs[0]!.sourceStatus).toBe('WAREHOUSE');
  });
});

describe('void/return restore math', () => {
  it('stockQtyRemoved uses quantityDeducted for WHOLE coil sales', () => {
    const removed = stockQtyRemoved({
      quantity: toDecimal(1),
      quantityDeducted: toDecimal(50),
    });
    expect(removed.toFixed(3)).toBe('50.000');
  });

  it('stockQtyRemoved falls back to billed qty for legacy rows', () => {
    expect(
      stockQtyRemoved({ quantity: toDecimal(7.5), quantityDeducted: null }).toFixed(3),
    ).toBe('7.500');
  });

  it('detects WHOLE sale lines when deducted ≠ billed', () => {
    expect(
      isWholeBatchSaleLine({ quantity: toDecimal(1), quantityDeducted: toDecimal(50) }),
    ).toBe(true);
    expect(
      isWholeBatchSaleLine({ quantity: toDecimal(12.5), quantityDeducted: toDecimal(12.5) }),
    ).toBe(false);
  });

  it('full return of WHOLE sale restores all deducted meters (not 1)', () => {
    const restore = stockQtyToRestore({
      billedQuantity: toDecimal(1),
      quantityDeducted: toDecimal(47.25),
      returnQty: toDecimal(1),
    });
    expect(restore.toFixed(3)).toBe('47.250');
  });

  it('partial return of LOOSE sale restores exact returned meters', () => {
    const restore = stockQtyToRestore({
      billedQuantity: toDecimal(10),
      quantityDeducted: toDecimal(10),
      returnQty: toDecimal(3.5),
    });
    expect(restore.toFixed(3)).toBe('3.500');
  });

  it('invariant: after LOOSE sale, product stock drop equals Σ batch remaining drop', () => {
    const beforeBatch = toDecimal(100);
    const beforeProduct = toDecimal(100);
    const sold = toDecimal(17.33);

    const allocs = planLooseAllocations({
      batches: [{ id: 'b1', remainingQuantity: beforeBatch, costPerUnit: toDecimal(1) }],
      quantitySold: sold,
      allowSplit: false,
      closeTolerance: toDecimal(0.1),
      productName: 'X',
      unit: 'm',
    });

    const deducted = allocs.reduce((s, a) => s.plus(a.quantityDeducted), toDecimal(0));
    const afterBatch = allocs[0]!.remainingAfter;
    const afterProduct = beforeProduct.minus(deducted);

    expect(deducted.toFixed(2)).toBe(roundQtySold(sold).toFixed(2));
    expect(beforeBatch.minus(afterBatch).toFixed(3)).toBe(deducted.toFixed(3));
    expect(afterProduct.toFixed(3)).toBe(afterBatch.toFixed(3));
  });

  it('invariant: void restore of WHOLE undoes product + batch meters exactly', () => {
    const remaining = toDecimal(60);
    const allocs = planWholeAllocation({
      batch: { id: 'w1', remainingQuantity: remaining, costPerUnit: toDecimal(5) },
      closeTolerance: toDecimal(0.1),
      unit: 'm',
    });
    const line = {
      quantity: allocs[0]!.quantitySold,
      quantityDeducted: allocs[0]!.quantityDeducted,
    };
    const productAfterSale = toDecimal(100).minus(stockQtyRemoved(line));
    const productAfterVoid = productAfterSale.plus(stockQtyRemoved(line));
    const batchAfterVoid = toDecimal(0).plus(stockQtyRemoved(line));

    expect(productAfterVoid.toFixed(3)).toBe('100.000');
    expect(batchAfterVoid.toFixed(3)).toBe('60.000');
    expect(isWholeBatchSaleLine(line)).toBe(true);
  });
});

describe('sale money vs stock independence', () => {
  it('WHOLE: money uses billed qty 1 × batch price; stock uses remaining', () => {
    const batchRemaining = new Decimal(40);
    const batchSellPrice = new Decimal(3000);
    const allocs = planWholeAllocation({
      batch: { id: 'c1', remainingQuantity: batchRemaining, costPerUnit: toDecimal(50) },
      closeTolerance: toDecimal(0.1),
      unit: 'm',
    });
    const billQty = allocs[0]!.quantitySold;
    const lineTotal = batchSellPrice.times(billQty);
    expect(lineTotal.toFixed(2)).toBe('3000.00');
    expect(allocs[0]!.quantityDeducted.toFixed(3)).toBe('40.000');
    expect(billQty.eq(allocs[0]!.quantityDeducted)).toBe(false);
  });
});
