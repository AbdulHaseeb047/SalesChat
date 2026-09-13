import type { Product } from '@/types/api';
import { formatQty } from '@/lib/format';

export interface CartLineInput {
  product: Product;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

export interface SaleTotals {
  subtotal: number;
  lineDiscount: number;
  billDiscount: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
}

export type BatchSaleMode = 'LOOSE' | 'WHOLE';

export function calcLineTax(
  unitPrice: number,
  quantity: number,
  discountAmount: number,
  taxRatePercent: number,
): number {
  const taxable = unitPrice * quantity - discountAmount;
  return taxable * (taxRatePercent / 100);
}

export function calcSaleTotals(
  lines: CartLineInput[],
  billDiscount: number,
  defaultTaxRate = 0,
): SaleTotals {
  let subtotal = 0;
  let lineDiscount = 0;
  let taxTotal = 0;

  for (const line of lines) {
    subtotal += line.unitPrice * line.quantity;
    lineDiscount += line.discountAmount;
    const taxRate = parseFloat(line.product.taxRate) || defaultTaxRate;
    taxTotal += calcLineTax(line.unitPrice, line.quantity, line.discountAmount, taxRate);
  }

  const discountTotal = lineDiscount + billDiscount;
  const grandTotal = Math.max(0, subtotal - discountTotal + taxTotal);

  return { subtotal, lineDiscount, billDiscount, discountTotal, taxTotal, grandTotal };
}

export function getStockStatus(product: Product): 'healthy' | 'low' | 'out' | 'untracked' {
  if (!product.trackStock) return 'untracked';
  const qty =
    product.trackType === 'BATCH'
      ? (product.batchStockCount ?? 0)
      : parseFloat(product.stockQuantity);
  const threshold = product.lowStockThreshold ? parseFloat(product.lowStockThreshold) : 0;
  if (qty <= 0) return 'out';
  if (threshold > 0 && qty <= threshold) return 'low';
  return 'healthy';
}

export function formatProductStock(product: Product): string {
  if (!product.trackStock) return '—';
  if (product.trackType === 'BATCH') {
    const warehouse = product.batchWarehouseCount ?? 0;
    const open = product.batchOpenCount ?? 0;
    const total = product.batchStockCount ?? warehouse + open;
    if (total <= 0) return '0 batches';
    const parts: string[] = [];
    if (warehouse > 0) parts.push(`${warehouse} in stock`);
    if (open > 0) parts.push(`${open} open`);
    return parts.length > 0 ? parts.join(' · ') : `${total} batches`;
  }
  return formatQty(product.stockQuantity);
}

export function formatBatchProductPrice(
  product: Product,
  currency: string,
  formatMoneyFn: (amount: string | number, currency: string) => string,
): { perUnit: string; wholeBatch: string } {
  const unit = product.unit || 'unit';
  return {
    perUnit: `${formatMoneyFn(product.sellPrice, currency)}/${unit}`,
    wholeBatch: formatMoneyFn(product.batchSellPrice ?? product.sellPrice, currency),
  };
}

export function canAddToCart(product: Product, addQty = 1, currentQty = 0): boolean {
  if (!product.trackStock) return true;
  return parseFloat(product.stockQuantity) >= currentQty + addQty;
}

/** Round billed qty to 2dp (matches server). */
export function roundSoldQty(qty: number): number {
  return Math.round(qty * 100) / 100;
}

export function qtyFromAmount(amount: number, pricePerUnit: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(pricePerUnit) || pricePerUnit <= 0) return 0;
  return roundSoldQty(amount / pricePerUnit);
}

export function amountFromQty(qty: number, pricePerUnit: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(pricePerUnit)) return 0;
  return Math.round(qty * pricePerUnit * 100) / 100;
}

export function isBatchProduct(product: Product): boolean {
  return product.trackType === 'BATCH' && product.trackStock;
}

export function needsBatchSaleModal(product: Product | null | undefined): boolean {
  return Boolean(product && isBatchProduct(product));
}

/** Loose / partial sales — per unit (e.g. PKR per meter). */
export function looseUnitPrice(product: Product): number {
  return parseFloat(product.sellPrice);
}

/** Whole warehouse batch — fixed total price (e.g. PKR 3000 for the full coil). */
export function wholeBatchPrice(product: Product): number {
  return parseFloat(product.batchSellPrice ?? product.sellPrice);
}

/** Qty on the bill: 1 for whole batch, else loose meters/kg. */
export function billedQuantity(saleMode: BatchSaleMode, looseQty: number): number {
  return saleMode === 'WHOLE' ? 1 : roundSoldQty(looseQty);
}

/** @deprecated Use looseUnitPrice or wholeBatchPrice */
export function batchUnitPrice(product: Product, saleMode: BatchSaleMode): number {
  return saleMode === 'WHOLE' ? wholeBatchPrice(product) : looseUnitPrice(product);
}

/** Instant client-side filter for name / SKU / barcode. */
export function productMatchesKeyword(product: Product, keyword: string): boolean {
  const q = keyword.trim().toLowerCase();
  if (!q) return true;
  return (
    product.name.toLowerCase().includes(q) ||
    (product.sku?.toLowerCase().includes(q) ?? false) ||
    (product.barcode?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Lower = better. Prefix matches beat “contains” matches
 * (typing "s" → Sugar before Basmati).
 */
export function productSearchRank(product: Product, keyword: string): number {
  const q = keyword.trim().toLowerCase();
  if (!q) return 0;

  const name = product.name.toLowerCase();
  const sku = product.sku?.toLowerCase() ?? '';
  const barcode = product.barcode?.toLowerCase() ?? '';

  if (name.startsWith(q)) return 0;
  if (sku.startsWith(q) || barcode.startsWith(q)) return 1;
  if (name.split(/[\s\-_/]+/).some((word) => word.startsWith(q))) return 2;
  if (name.includes(q) || sku.includes(q) || barcode.includes(q)) return 3;
  return 99;
}

/** Filter by keyword, then rank: starts-with first, then contains. */
export function filterAndRankProducts(products: Product[], keyword: string): Product[] {
  const q = keyword.trim();
  if (!q) return products;

  return products
    .filter((p) => productMatchesKeyword(p, q))
    .sort((a, b) => {
      const rankDiff = productSearchRank(a, q) - productSearchRank(b, q);
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}
