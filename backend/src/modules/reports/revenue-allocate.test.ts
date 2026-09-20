import { describe, expect, it } from 'vitest';

import { allocateRevenueByLineShare } from './revenue-allocate.js';

describe('allocateRevenueByLineShare', () => {
  it('allocates bill discount so part revenue matches grand total (1000 − 20 = 980)', () => {
    const shares = allocateRevenueByLineShare([1000], 980);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.toFixed(2)).toBe('980.00');
  });

  it('splits bill discount across multiple lines by line share', () => {
    // Lines 600 + 400 = 1000; bill discount 20 → grand 980
    const shares = allocateRevenueByLineShare([600, 400], 980);
    expect(shares[0]!.toFixed(2)).toBe('588.00'); // 600/1000 * 980
    expect(shares[1]!.toFixed(2)).toBe('392.00'); // remainder
    const sum = shares[0]!.plus(shares[1]!);
    expect(sum.toFixed(2)).toBe('980.00');
  });

  it('leaves line totals unchanged when they already equal grand total', () => {
    const shares = allocateRevenueByLineShare([500, 480], 980);
    expect(shares[0]!.toFixed(2)).toBe('500.00');
    expect(shares[1]!.toFixed(2)).toBe('480.00');
  });

  it('returns zeros when line totals are zero', () => {
    const shares = allocateRevenueByLineShare([0, 0], 0);
    expect(shares[0]!.toFixed(2)).toBe('0.00');
    expect(shares[1]!.toFixed(2)).toBe('0.00');
  });
});
