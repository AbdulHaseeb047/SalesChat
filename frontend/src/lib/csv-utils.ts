export const CSV_IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const CSV_IMPORT_MAX_ROWS = 5000;
export const CSV_IMPORT_MAX_ERRORS = 50;

export function escapeCsvCell(value: unknown): string {
  const str = value == null ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function detectCsvDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<',' | ';' | '\t', number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i]!;
    if (ch === '"') {
      if (inQuotes && firstLine[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) {
      counts[ch] += 1;
    }
  }
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > 0) return '\t';
  return ',';
}

export function parseCsv(text: string, delimiter: ',' | ';' | '\t' = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n' || (char === '\r' && next === '\n')) {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
      if (char === '\r') i++;
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }

  return rows;
}

/** Yield to the browser so the UI can paint between heavy work. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export async function parseCsvFileText(text: string): Promise<string[][]> {
  const delimiter = detectCsvDelimiter(text);
  await yieldToUi();
  return parseCsv(text, delimiter);
}

export const INVENTORY_CSV_HEADERS = [
  'name',
  'sku',
  'barcode',
  'sell_price',
  'cost_price',
  'unit',
  'category',
  'shop_part',
  'brand',
  'supplier',
  'stock_quantity',
  'low_stock_threshold',
  'target_stock',
  'track_stock',
  'expiry_date',
] as const;

export type InventoryCsvField = (typeof INVENTORY_CSV_HEADERS)[number];

/** Map CSV column index → system field. `-1` / missing = ignore column. */
export type InventoryCsvColumnMapping = Partial<Record<InventoryCsvField, number>>;

export const INVENTORY_CSV_FIELD_META: Array<{
  field: InventoryCsvField;
  label: string;
  required?: boolean;
}> = [
  { field: 'name', label: 'Product name', required: true },
  { field: 'sell_price', label: 'Sell price', required: true },
  { field: 'cost_price', label: 'Cost price' },
  { field: 'sku', label: 'SKU' },
  { field: 'barcode', label: 'Barcode' },
  { field: 'unit', label: 'Unit' },
  { field: 'category', label: 'Category' },
  { field: 'shop_part', label: 'Shop part' },
  { field: 'brand', label: 'Brand' },
  { field: 'supplier', label: 'Supplier' },
  { field: 'stock_quantity', label: 'Stock quantity' },
  { field: 'low_stock_threshold', label: 'Low stock threshold' },
  { field: 'target_stock', label: 'Target stock' },
  { field: 'track_stock', label: 'Track stock' },
  { field: 'expiry_date', label: 'Expiry date' },
];

/**
 * Aliases are intentionally specific. Avoid generic words (code, type, description, pcs)
 * that collide with unrelated columns and import wrong data.
 */
const HEADER_ALIASES: Record<InventoryCsvField, string[]> = {
  name: [
    'name',
    'product',
    'product_name',
    'productname',
    'item_name',
    'itemname',
    'product_title',
    'item',
  ],
  sku: ['sku', 'sku_code', 'skucode', 'item_code', 'itemcode', 'product_code', 'productcode'],
  barcode: [
    'barcode',
    'bar_code',
    'ean',
    'upc',
    'gtin',
    'product_barcode',
    'barcodeno',
    'barcode_no',
  ],
  sell_price: [
    'sell_price',
    'sellprice',
    'selling_price',
    'sellingprice',
    'sale_price',
    'saleprice',
    'price',
    'mrp',
    'rsp',
    'retail_price',
    'retailprice',
    'unit_price',
    'unitprice',
    'sales_price',
    'salesprice',
  ],
  cost_price: [
    'cost_price',
    'costprice',
    'cost',
    'purchase_price',
    'purchaseprice',
    'buy_price',
    'buyprice',
    'wholesale_price',
    'wholesaleprice',
  ],
  unit: ['unit', 'uom', 'unit_of_measure', 'unitofmeasure'],
  category: ['category', 'product_category', 'productcategory', 'category_name', 'categoryname'],
  shop_part: [
    'shop_part',
    'shoppart',
    'part',
    'part_name',
    'partname',
    'shop_section',
    'section',
    'hissa',
  ],
  brand: ['brand', 'brand_name', 'brandname', 'make'],
  supplier: ['supplier', 'supplier_name', 'suppliername', 'vendor', 'vendor_name'],
  stock_quantity: [
    'stock_quantity',
    'stockquantity',
    'stock',
    'qty',
    'quantity',
    'qty_on_hand',
    'stock_qty',
    'stockqty',
    'opening_stock',
    'openingstock',
    'on_hand',
    'onhand',
  ],
  low_stock_threshold: [
    'low_stock_threshold',
    'lowstockthreshold',
    'reorder_level',
    'reorderlevel',
    'min_stock',
    'minstock',
    'minimum_stock',
    'low_stock',
    'lowstock',
  ],
  target_stock: ['target_stock', 'targetstock', 'target_quantity', 'stock_target'],
  track_stock: ['track_stock', 'trackstock', 'manage_stock', 'managestock'],
  expiry_date: [
    'expiry_date',
    'expirydate',
    'expiry',
    'expire_date',
    'expiration_date',
    'expirationdate',
    'best_before',
    'bestbefore',
  ],
};

/** Normalize heading for matching: lowercase, strip punctuation, collapse spaces. */
export function normalizeCsvHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'y';
}

/** Accepts 1,250.50 / Rs 500 / PKR 500 / $12.5 */
function parseNumber(value: string): number | null {
  let trimmed = value.trim();
  if (!trimmed) return null;
  trimmed = trimmed
    .replace(/^(rs\.?|pkr|usd|\$|€|£)\s*/i, '')
    .replace(/\s*(rs\.?|pkr|usd|\$|€|£)$/i, '')
    .replace(/,/g, '')
    .trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface InventoryCsvRow {
  name: string;
  sellPrice: number;
  costPrice?: number | null;
  sku?: string | null;
  barcode?: string | null;
  unit?: string;
  categoryName?: string | null;
  partName?: string | null;
  brandName?: string | null;
  supplierName?: string | null;
  stockQuantity?: number;
  lowStockThreshold?: number | null;
  targetStock?: number | null;
  trackStock?: boolean;
  expiryDate?: string | null;
}

/**
 * Auto-suggest which CSV column maps to each system field using aliases.
 * Each CSV column is used at most once (first best match wins by field order).
 */
export function suggestInventoryColumnMapping(headers: string[]): {
  mapping: InventoryCsvColumnMapping;
  unmatchedHeaders: string[];
  missingRequired: InventoryCsvField[];
} {
  const normalized = headers.map((h) => normalizeCsvHeader(h));
  const used = new Set<number>();
  const mapping: InventoryCsvColumnMapping = {};

  for (const field of INVENTORY_CSV_HEADERS) {
    const aliases = HEADER_ALIASES[field];
    let found = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (used.has(i)) continue;
      const h = normalized[i]!;
      if (aliases.includes(h)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      mapping[field] = found;
      used.add(found);
    }
  }

  const unmatchedHeaders = headers.filter((_, i) => !used.has(i) && headers[i]!.trim());
  const missingRequired = INVENTORY_CSV_FIELD_META.filter(
    (f) => f.required && mapping[f.field] == null,
  ).map((f) => f.field);

  return { mapping, unmatchedHeaders, missingRequired };
}

function pushError(errors: string[], message: string): void {
  if (errors.length < CSV_IMPORT_MAX_ERRORS) {
    errors.push(message);
  } else if (errors.length === CSV_IMPORT_MAX_ERRORS) {
    errors.push(`…and more issues (showing first ${CSV_IMPORT_MAX_ERRORS} only)`);
  }
}

export function csvRowsToImportProducts(
  rows: string[][],
  mappingOverride?: InventoryCsvColumnMapping,
): {
  products: InventoryCsvRow[];
  errors: string[];
  mapping: InventoryCsvColumnMapping;
  unmatchedHeaders: string[];
  missingRequired: InventoryCsvField[];
  truncated: boolean;
} {
  if (rows.length === 0) {
    return {
      products: [],
      errors: ['CSV file is empty'],
      mapping: {},
      unmatchedHeaders: [],
      missingRequired: ['name', 'sell_price'],
      truncated: false,
    };
  }

  const headers = rows[0]!.map((h) => h.trim());
  const suggested = suggestInventoryColumnMapping(headers);
  const mapping = mappingOverride ?? suggested.mapping;
  const dataRows = rows.slice(1);
  const truncated = dataRows.length > CSV_IMPORT_MAX_ROWS;
  const limitedRows = truncated ? dataRows.slice(0, CSV_IMPORT_MAX_ROWS) : dataRows;
  const errors: string[] = [];
  const products: InventoryCsvRow[] = [];

  if (truncated) {
    pushError(
      errors,
      `CSV has ${dataRows.length} data rows — only the first ${CSV_IMPORT_MAX_ROWS} will be imported. Split the file to import the rest.`,
    );
  }

  const missingRequired = INVENTORY_CSV_FIELD_META.filter(
    (f) => f.required && (mapping[f.field] == null || mapping[f.field]! < 0),
  ).map((f) => f.field);

  if (missingRequired.length > 0) {
    pushError(
      errors,
      `Required columns not mapped: ${missingRequired.join(', ')}. Match your CSV headings to these fields before importing.`,
    );
    const usedIdx = new Set(
      Object.values(mapping).filter((i): i is number => typeof i === 'number' && i >= 0),
    );
    const unmatchedHeaders = headers.filter((_, i) => !usedIdx.has(i) && headers[i]!.trim());
    return {
      products: [],
      errors,
      mapping,
      unmatchedHeaders,
      missingRequired,
      truncated,
    };
  }

  const col = (field: InventoryCsvField, cells: string[]) => {
    const idx = mapping[field];
    if (idx == null || idx < 0) return '';
    return (cells[idx] ?? '').trim();
  };

  for (let i = 0; i < limitedRows.length; i++) {
    const cells = limitedRows[i]!;
    if (cells.every((c) => !c.trim())) continue;

    const name = col('name', cells);
    const sellPrice = parseNumber(col('sell_price', cells));

    if (!name) {
      pushError(errors, `Row ${i + 2}: name is required`);
      continue;
    }
    if (sellPrice == null || sellPrice < 0) {
      pushError(errors, `Row ${i + 2}: valid sell price is required`);
      continue;
    }

    const stockQty = parseNumber(col('stock_quantity', cells));
    const lowStock = parseNumber(col('low_stock_threshold', cells));
    const targetStock = parseNumber(col('target_stock', cells));
    const trackStockRaw = col('track_stock', cells);
    const costPrice = parseNumber(col('cost_price', cells));

    products.push({
      name: name.slice(0, 255),
      sellPrice,
      costPrice,
      sku: (col('sku', cells) || null)?.slice(0, 100) ?? null,
      barcode: (col('barcode', cells) || null)?.slice(0, 100) ?? null,
      unit: (col('unit', cells) || 'pcs').slice(0, 50),
      categoryName: (col('category', cells) || null)?.slice(0, 255) ?? null,
      partName: (col('shop_part', cells) || null)?.slice(0, 255) ?? null,
      brandName: (col('brand', cells) || null)?.slice(0, 255) ?? null,
      supplierName: (col('supplier', cells) || null)?.slice(0, 255) ?? null,
      stockQuantity: stockQty ?? undefined,
      lowStockThreshold: lowStock,
      targetStock,
      trackStock: trackStockRaw ? parseBool(trackStockRaw) : true,
      expiryDate: col('expiry_date', cells) || null,
    });
  }

  if (products.length === 0 && !errors.some((e) => e.includes('Required columns'))) {
    pushError(errors, 'No valid product rows found. Check column mapping and sell prices.');
  }

  const usedIdx = new Set(
    Object.values(mapping).filter((i): i is number => typeof i === 'number' && i >= 0),
  );
  const unmatchedHeaders = headers.filter((_, i) => !usedIdx.has(i) && headers[i]!.trim());

  return { products, errors, mapping, unmatchedHeaders, missingRequired: [], truncated };
}

export function productToCsvRow(p: {
  name: string;
  sku: string | null;
  barcode: string | null;
  sellPrice: string;
  costPrice: string | null;
  unit: string;
  category?: { name: string } | null;
  brand?: { name: string } | null;
  supplier?: { name: string } | null;
  stockQuantity: string;
  lowStockThreshold: string | null;
  targetStock: string | null;
  trackStock: boolean;
  expiryDate: string | null;
}): string[] {
  return [
    p.name,
    p.sku ?? '',
    p.barcode ?? '',
    p.sellPrice,
    p.costPrice ?? '',
    p.unit,
    p.category?.name ?? '',
    p.brand?.name ?? '',
    p.supplier?.name ?? '',
    p.stockQuantity,
    p.lowStockThreshold ?? '',
    p.targetStock ?? '',
    p.trackStock ? 'true' : 'false',
    p.expiryDate ?? '',
  ];
}
