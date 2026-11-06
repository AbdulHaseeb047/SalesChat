import { describe, expect, it } from 'vitest';

import { calculateTargetStockAmount } from './target-stock.js';

describe('calculateTargetStockAmount', () => {
  it('multiplies cost price by target stock for simple products', () => {
    expect(
      calculateTargetStockAmount({ trackStock: true, targetStock: 50, costPrice: 120 }),
    ).toBe(6000);
  });

  it('uses the full target regardless of current stock', () => {
    expect(
      calculateTargetStockAmount({
        trackStock: true,
        trackType: 'SIMPLE',
        targetStock: '10.00',
        costPrice: '25.50',
      }),
    ).toBe(255);
  });

  it('multiplies the latest batch cost by target batches for batch products', () => {
    expect(
      calculateTargetStockAmount(
        { trackStock: true, trackType: 'BATCH', targetStock: 4, costPrice: null },
        3000,
      ),
    ).toBe(12000);
  });

  it('returns 0 when no target is set or stock is not tracked', () => {
    expect(calculateTargetStockAmount({ trackStock: true, targetStock: 0, costPrice: 100 })).toBe(0);
    expect(calculateTargetStockAmount({ trackStock: false, targetStock: 5, costPrice: 100 })).toBe(0);
  });

  it('returns null when a target is set but the cost is unknown', () => {
    expect(calculateTargetStockAmount({ trackStock: true, targetStock: 5, costPrice: null })).toBeNull();
    expect(calculateTargetStockAmount({ trackStock: true, targetStock: 5, costPrice: 0 })).toBeNull();
    expect(
      calculateTargetStockAmount({ trackStock: true, trackType: 'BATCH', targetStock: 5 }, null),
    ).toBeNull();
  });
});
