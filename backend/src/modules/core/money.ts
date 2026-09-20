import { Decimal } from '@prisma/client/runtime/library';

export function toDecimal(value: number | string | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function formatMoney(value: Decimal): string {
  return formatDisplayDecimal(value, 2);
}

/**
 * API/display decimals: whole numbers without trailing zeros;
 * otherwise at most `maxDp` places (default 2).
 */
export function formatDisplayDecimal(
  value: number | string | Decimal,
  maxDp = 2,
): string {
  const d = toDecimal(value).toDecimalPlaces(maxDp, Decimal.ROUND_HALF_UP);
  if (d.equals(d.toDecimalPlaces(0))) {
    return d.toFixed(0);
  }
  return d.toFixed(maxDp).replace(/\.?0+$/, '');
}
