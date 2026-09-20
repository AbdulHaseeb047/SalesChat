/** Strip trailing zeros: 100 → "100", 12.5 → "12.5", 12.50 → "12.5" (max 2 dp). */
export function formatDecimal(
  value: string | number | null | undefined,
  maxFractionDigits = 2,
): string {
  if (value == null || value === '') return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return '0';
  const rounded =
    Math.round(num * Math.pow(10, maxFractionDigits)) / Math.pow(10, maxFractionDigits);
  if (Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return String(Math.round(rounded));
  }
  return String(parseFloat(rounded.toFixed(maxFractionDigits)));
}

/** Form/input values from API — empty when null; same rules as formatDecimal. */
export function formatDecimalInput(
  value: string | number | null | undefined,
  maxFractionDigits = 2,
): string {
  if (value == null || value === '') return '';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return '';
  return formatDecimal(num, maxFractionDigits);
}

export function formatMoney(value: string | number, currency = 'PKR'): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(num)) return `${currency} 0`;
  // Whole amounts without .00; fractional amounts up to 2 dp (en-IN grouping for PKR).
  return `${currency} ${num.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Stock/qty display: whole numbers without .000; at most 2 decimal places. */
export function formatQty(value: string | number | null | undefined, maxFractionDigits = 2): string {
  return formatDecimal(value, maxFractionDigits);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-PK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-PK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Local calendar YYYY-MM-DD (not UTC — avoids off-by-one in PK / other offsets). */
export function localDateIso(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayIso(): string {
  return localDateIso();
}

/** True if an ISO timestamp falls on a local calendar day within [from, to] inclusive. */
export function isTimestampInLocalDateRange(iso: string, from: string, to: string): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T23:59:59.999`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return t >= lo && t <= hi;
}
