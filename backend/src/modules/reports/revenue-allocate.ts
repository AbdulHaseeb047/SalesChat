import { Decimal } from '@prisma/client/runtime/library';

import { toDecimal } from '../core/money.js';

/**
 * Bill-level discounts reduce sale.grandTotal but are NOT stored on sale_items.line_total.
 * Sum(lineTotal) = grandTotal + billDiscount. Allocate grandTotal across lines by share
 * so part/product revenue matches the real collected amount.
 */
export function allocateRevenueByLineShare(
  lineTotals: Array<number | string | Decimal>,
  grandTotal: number | string | Decimal,
): Decimal[] {
  const totals = lineTotals.map((v) => toDecimal(v));
  const target = toDecimal(grandTotal);
  if (totals.length === 0) return [];

  const sum = totals.reduce((s, v) => s.plus(v), new Decimal(0));
  if (sum.lte(0)) {
    return totals.map(() => new Decimal(0));
  }

  // Already matches (no bill discount / fully line-discounted) — avoid rounding drift.
  if (sum.eq(target)) {
    return totals;
  }

  const out: Decimal[] = [];
  let allocated = new Decimal(0);
  for (let i = 0; i < totals.length; i++) {
    if (i === totals.length - 1) {
      out.push(target.minus(allocated));
    } else {
      const share = target.times(totals[i]!).div(sum).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      out.push(share);
      allocated = allocated.plus(share);
    }
  }
  return out;
}
