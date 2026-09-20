import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from '@/lib/next-nav';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageSkeleton, TableSkeleton } from '@/components/ui/PageSkeleton';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { IconBox } from '@/components/icons';
import { api, ApiError, formatApiError } from '@/lib/api-client';
import {
  CSV_IMPORT_MAX_BYTES,
  CSV_IMPORT_MAX_ROWS,
  INVENTORY_CSV_FIELD_META,
  INVENTORY_CSV_HEADERS,
  csvRowsToImportProducts,
  downloadCsv,
  parseCsvFileText,
  productToCsvRow,
  yieldToUi,
  type InventoryCsvColumnMapping,
  type InventoryCsvField,
  type InventoryCsvRow,
} from '@/lib/csv-utils';
import { FEATURES, hasFeature } from '@/lib/features';
import { useAuth } from '@/lib/auth';
import { formatMoney, formatQty, formatDecimalInput, todayIso } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { productMatchesSearch } from '@/lib/search-match';
import { formatProductStock, formatBatchProductPrice, getStockStatus } from '@/lib/sale-utils';
import type { BatchSummary, Product, ProductBatch } from '@/types/api';

const PAGE_SIZE = 20;
const STOCK_FILTERS = new Set(['all', 'healthy', 'low', 'out']);
const MOVEMENT_DAYS = 14;
const PRODUCT_IMAGE_MAX_BYTES = 500_000;
const PRODUCT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function parseStockParam(value: string | null): string {
  if (value && STOCK_FILTERS.has(value)) return value;
  return 'all';
}

function batchPurchaseTotal(batch: ProductBatch): number {
  return parseFloat(batch.costPerUnit) * parseFloat(batch.initialQuantity);
}

function isWarehouseBatchStatus(status: ProductBatch['status']): boolean {
  return status === 'WAREHOUSE';
}

function isCounterOpenBatchStatus(status: ProductBatch['status']): boolean {
  return status === 'OPEN';
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function shortDayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' });
}

function MovementTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <p className="mb-1.5 font-semibold text-text">{label}</p>
      {payload.map((row) => {
        const key = String(row.dataKey ?? '');
        const isIn = key === 'in';
        return (
          <p
            key={key}
            className={`font-semibold tabular-nums ${isIn ? 'text-emerald-700' : 'text-rose-700'}`}
          >
            {isIn ? 'Stock in' : 'Stock out'}:{' '}
            {Number(row.value ?? 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}
          </p>
        );
      })}
    </div>
  );
}

function BatchProfitPanel({
  summary,
  currency,
  unit,
}: {
  summary: BatchSummary;
  currency: string;
  unit: string;
}) {
  const profit = parseFloat(summary.netProfit);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-[10px] uppercase text-text-muted">
          {summary.isFinal ? 'Final profit' : 'Est. profit'}
        </p>
        <p
          className={`text-lg font-bold tabular-nums ${profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {formatMoney(summary.netProfit, currency)}
        </p>
        {!summary.isFinal && (
          <p className="text-[10px] text-text-muted">Pending cylinder close-out</p>
        )}
      </div>
      <div>
        <p className="text-[10px] uppercase text-text-muted">Revenue · {summary.saleCount} charges</p>
        <p className="font-semibold tabular-nums">{formatMoney(summary.revenue, currency)}</p>
        <p className="text-[10px] text-text-muted">
          COGS sold: {formatMoney(summary.cogsSold, currency)}
        </p>
      </div>
      <div>
        <p className="text-[10px] uppercase text-text-muted">
          {summary.isFinal ? 'Gas loss (written off)' : 'Est. gas loss (remaining)'}
        </p>
        <p className="font-semibold tabular-nums">
          {summary.gasLossQuantity} {unit}
        </p>
        <p className="text-[10px] text-text-muted">
          {formatMoney(summary.gasLossCost, currency)} · {summary.effectiveLossPercent}% of cylinder
        </p>
      </div>
      <div>
        <p className="text-[10px] uppercase text-text-muted">Avg loss / charge</p>
        <p className="font-semibold tabular-nums">
          {summary.avgLossPerCharge != null
            ? `${summary.avgLossPerCharge} ${unit}`
            : summary.saleCount > 0
              ? 'Final after close'
              : '—'}
        </p>
        <p className="text-[10px] text-text-muted">
          Purchase cost: {formatMoney(summary.purchaseCost, currency)}
        </p>
      </div>
    </div>
  );
}

export function InventoryPage() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 150);
  const [stockStatus, setStockStatus] = useState(() => parseStockParam(searchParams.get('stock')));
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [partFilter, setPartFilter] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignPartId, setBulkAssignPartId] = useState('');
  const [modal, setModal] = useState<
    'create' | 'edit' | 'stock' | 'receive' | 'batches' | 'adjust-batch' | 'close-batch' | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<ProductBatch | null>(null);
  const [form, setForm] = useState({
    name: '',
    sellPrice: '',
    costPrice: '',
    barcode: '',
    sku: '',
    imageUrl: '',
    unit: 'pcs',
    categoryId: '',
    partId: '',
    brandId: '',
    supplierId: '',
    expiryDate: '',
    trackStock: true,
    trackType: 'SIMPLE' as 'SIMPLE' | 'BATCH',
    batchSellPrice: '',
    dispensingLossPercent: '0',
    lowStockThreshold: '',
  });
  const [formErrorVisible, setFormErrorVisible] = useState(false);
  const [stockDelta, setStockDelta] = useState('');
  const [batchForm, setBatchForm] = useState({
    purchaseDate: todayIso(),
    supplier: '',
    purchaseReference: '',
    purchaseCostPerBatch: '',
    batchCount: '1',
    quantityPerBatch: '',
    notes: '',
    qtyEstimated: false,
  });
  const [adjustForm, setAdjustForm] = useState({
    remainingQuantity: '',
    reason: '',
    markDamaged: false,
  });
  const [productBatches, setProductBatches] = useState<ProductBatch[]>([]);
  const [batchSummaries, setBatchSummaries] = useState<Record<string, BatchSummary>>({});
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [expandedBatchSection, setExpandedBatchSection] = useState<'warehouse' | 'open' | null>(
    null,
  );
  const [closeOutTarget, setCloseOutTarget] = useState<ProductBatch | null>(null);
  const [closeOutReason, setCloseOutReason] = useState('');
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [receiveFormError, setReceiveFormError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{ count: number; errors: string[] } | null>(
    null,
  );
  const [importRows, setImportRows] = useState<InventoryCsvRow[]>([]);
  const [importRawRows, setImportRawRows] = useState<string[][] | null>(null);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importMapping, setImportMapping] = useState<InventoryCsvColumnMapping>({});
  const [importUnmatched, setImportUnmatched] = useState<string[]>([]);
  const [importParsing, setImportParsing] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importParseGen = useRef(0);
  const skipMapEffect = useRef(false);
  const debouncedImportMapping = useDebouncedValue(importMapping, 280);

  const canEdit = hasFeature(user, FEATURES.INVENTORY_EDIT);
  const canAdjust = hasFeature(user, FEATURES.INVENTORY_STOCK_ADJUST);
  const canUseProductImages = hasFeature(user, FEATURES.INVENTORY_PRODUCT_IMAGES);
  const canUseShopParts = hasFeature(user, FEATURES.INVENTORY_SHOP_PARTS);

  useEffect(() => {
    const next = parseStockParam(searchParams.get('stock'));
    setStockStatus((prev) => (prev === next ? prev : next));
    setPage(1);
  }, [searchParams]);

  const applyStockStatus = (value: string) => {
    const next = parseStockParam(value);
    setStockStatus(next);
    setPage(1);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'all') params.delete('stock');
        else params.set('stock', next);
        return params;
      },
      { replace: true },
    );
  };

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.categories.list(),
    enabled: hasFeature(user, FEATURES.INVENTORY_CATEGORIES),
  });
  const { data: shopParts } = useQuery({
    queryKey: ['shop-parts'],
    queryFn: () => api.shopParts.list(),
    enabled: canUseShopParts,
  });
  const { data: brands } = useQuery({
    queryKey: ['brands'],
    queryFn: () => api.brands.list(),
    enabled: hasFeature(user, FEATURES.INVENTORY_BRANDS),
  });
  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.suppliers.list(),
    enabled: hasFeature(user, FEATURES.INVENTORY_SUPPLIERS),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['products', 'inventory', debouncedSearch, stockStatus, categoryFilter, partFilter, page],
    queryFn: () =>
      api.products.list({
        search: debouncedSearch.trim() || undefined,
        stockStatus: stockStatus === 'all' ? undefined : stockStatus,
        categoryId: categoryFilter.trim() || undefined,
        partId: partFilter.trim() || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    staleTime: 0,
    refetchOnMount: 'always',
    placeholderData: (prev) => prev,
  });

  const { data: batchStockCounts } = useQuery({
    queryKey: ['batch-stock-counts'],
    queryFn: () => api.products.batchStockCounts(),
    staleTime: 30_000,
  });

  // Heavy full-catalog aggregate — load after the product list paints.
  const { data: summary } = useQuery({
    queryKey: ['inventory-summary'],
    queryFn: () => api.products.summary(),
    enabled: Boolean(data),
    staleTime: 60_000,
  });

  const { data: openBatchRows } = useQuery({
    queryKey: ['batches', 'open'],
    queryFn: () => api.products.listOpenBatches(),
    enabled: Boolean(data),
    staleTime: 30_000,
  });

  const movementFrom = daysAgoIso(MOVEMENT_DAYS - 1);
  const movementTo = todayIso();
  const canViewReports = hasFeature(user, FEATURES.REPORTS_VIEW);
  const { data: stockMovement } = useQuery({
    queryKey: ['reports', 'stock', 'inventory-card', movementFrom, movementTo],
    queryFn: () => api.reports.stockMovement(movementFrom, movementTo, 500),
    enabled: Boolean(data) && canViewReports,
    staleTime: 60_000,
  });

  const movementChart = useMemo(() => {
    const days: Array<{ key: string; label: string; inQty: number; outQty: number }> = [];
    for (let i = MOVEMENT_DAYS - 1; i >= 0; i--) {
      const key = daysAgoIso(i);
      days.push({ key, label: shortDayLabel(key), inQty: 0, outQty: 0 });
    }
    const byKey = new Map(days.map((d) => [d.key, d]));
    for (const m of stockMovement?.movements ?? []) {
      const key = m.createdAt.slice(0, 10);
      const bucket = byKey.get(key);
      if (!bucket) continue;
      const delta = Number(m.quantityDelta);
      if (!Number.isFinite(delta) || delta === 0) continue;
      if (delta > 0) bucket.inQty += delta;
      else bucket.outQty += Math.abs(delta);
    }
    return days.map((d) => ({
      label: d.label,
      in: Math.round(d.inQty * 1000) / 1000,
      out: Math.round(d.outQty * 1000) / 1000,
      volume: Math.round((d.inQty + d.outQty) * 1000) / 1000,
    }));
  }, [stockMovement]);

  const hasMovement = movementChart.some((d) => d.volume > 0);
  const movementTotals = useMemo(() => {
    let inn = 0;
    let out = 0;
    for (const d of movementChart) {
      inn += d.in;
      out += d.out;
    }
    return {
      in: Math.round(inn * 1000) / 1000,
      out: Math.round(out * 1000) / 1000,
    };
  }, [movementChart]);

  const displayedProducts = useMemo(() => {
    const rows = data?.data ?? [];
    const withBatchCounts = rows.map((p) => {
      if (p.trackType !== 'BATCH') return p;
      const counts = batchStockCounts?.[p.id];
      if (!counts) return p;
      return {
        ...p,
        batchWarehouseCount: counts.warehouse,
        batchOpenCount: counts.open,
        batchStockCount: counts.total,
      };
    });
    const q = search.trim();
    if (!q) return withBatchCounts;
    return withBatchCounts.filter((p) => productMatchesSearch(p, q));
  }, [data?.data, search, batchStockCounts]);
  const warehouseProductBatches = useMemo(
    () => productBatches.filter((b) => isWarehouseBatchStatus(b.status)),
    [productBatches],
  );
  const openCounterBatches = useMemo(
    () => productBatches.filter((b) => isCounterOpenBatchStatus(b.status)),
    [productBatches],
  );
  const meta = data?.meta;
  const listLoading = isLoading || (isFetching && !data);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryFilter, partFilter]);

  useEffect(() => {
    setSelectedProductIds(new Set());
  }, [debouncedSearch, categoryFilter, partFilter, page]);


  const deleteProduct = useMutation({
    mutationFn: (id: string) => api.products.delete(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const saveProduct = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        sellPrice: parseFloat(form.sellPrice),
        batchSellPrice:
          form.trackType === 'BATCH' && form.batchSellPrice.trim()
            ? parseFloat(form.batchSellPrice)
            : null,
        costPrice:
          form.trackType === 'BATCH'
            ? null
            : form.costPrice
              ? parseFloat(form.costPrice)
              : null,
        barcode: form.barcode || null,
        sku: form.sku || null,
        ...(canUseProductImages ? { imageUrl: form.imageUrl || null } : {}),
        unit: form.unit,
        categoryId: form.categoryId || null,
        partId: canUseShopParts ? form.partId || null : undefined,
        brandId: form.brandId || null,
        supplierId: form.supplierId || null,
        expiryDate: form.expiryDate || null,
        trackStock: form.trackStock,
        trackType: form.trackType,
        dispensingLossPercent:
          form.trackType === 'BATCH' ? parseFloat(form.dispensingLossPercent || '0') : 0,
        lowStockThreshold: form.lowStockThreshold ? parseFloat(form.lowStockThreshold) : null,
      };
      return modal === 'edit' && selected
        ? api.products.update(selected.id, body)
        : api.products.create(body);
    },
    onSuccess: () => {
      setModal(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not save product');
    },
  });

  const adjustStock = useMutation({
    mutationFn: () =>
      api.products.adjustStock(selected!.id, {
        quantityDelta: parseFloat(stockDelta),
        movementType: 'ADJUSTMENT',
      }),
    onSuccess: () => {
      setModal(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'stock'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not adjust stock');
    },
  });

  const receiveBatchMut = useMutation({
    mutationFn: async () => {
      const batchCount = Math.min(500, Math.max(1, Math.trunc(Number(batchForm.batchCount))));
      const qtyPerBatch = parseFloat(batchForm.quantityPerBatch);
      const costPerBatch = parseFloat(batchForm.purchaseCostPerBatch);
      const baseNotes = batchForm.notes.trim();
      const notes = batchForm.qtyEstimated
        ? [
            'Estimated qty per batch — correct with Adjust after weighing/measuring.',
            baseNotes || null,
          ]
            .filter(Boolean)
            .join(' ')
        : baseNotes || null;

      const singlePayload = {
        purchaseDate: batchForm.purchaseDate,
        supplier: batchForm.supplier.trim() || null,
        purchaseReference: batchForm.purchaseReference.trim() || null,
        quantityPerBatch: qtyPerBatch,
        initialQuantity: qtyPerBatch,
        purchaseCostPerBatch: costPerBatch,
        totalPurchaseCost: costPerBatch,
        costPerUnit: Math.round((costPerBatch / qtyPerBatch) * 10000) / 10000,
        notes,
      };

      const productId = selected!.id;

      if (batchCount === 1) {
        const result = await api.products.receiveBatch(productId, {
          ...singlePayload,
          batchCount: 1,
        });
        return { ...result, batchCount: 1 };
      }

      // Try one bulk request (new backend creates all rows in one transaction).
      try {
        const bulk = await api.products.receiveBatch(productId, {
          ...singlePayload,
          batchCount,
        });
        const createdCount = bulk.batches?.length ?? bulk.batchCount ?? 0;
        if (createdCount >= batchCount) {
          return bulk;
        }
        // Old backend ignored batchCount — finish the rest one at a time.
        let last = bulk;
        for (let i = createdCount; i < batchCount; i++) {
          last = await api.products.receiveBatch(productId, singlePayload);
        }
        return {
          ...last,
          batchCount,
          totalQuantity: String(batchCount * qtyPerBatch),
        };
      } catch {
        // Fallback: one API call per physical batch.
        let last = await api.products.receiveBatch(productId, singlePayload);
        for (let i = 1; i < batchCount; i++) {
          last = await api.products.receiveBatch(productId, singlePayload);
        }
        return {
          ...last,
          batchCount,
          totalQuantity: String(batchCount * qtyPerBatch),
        };
      }
    },
    onSuccess: (result) => {
      setModal(null);
      setReceiveFormError('');
      const count = result.batchCount;
      toast.success(
        count > 1
          ? `${count} batches received (${result.totalQuantity} ${selected?.unit ?? 'units'} total)`
          : batchForm.qtyEstimated
            ? 'Batch received (estimated). Adjust after you weigh/measure.'
            : 'Batch received',
      );
      if (selected) {
        queryClient.setQueriesData(
          { queryKey: ['products'] },
          (old: { data?: Product[]; meta?: unknown } | undefined) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: old.data.map((p) =>
                p.id === selected.id && p.trackType === 'BATCH'
                  ? {
                      ...p,
                      batchWarehouseCount: (p.batchWarehouseCount ?? 0) + count,
                      batchStockCount: (p.batchStockCount ?? 0) + count,
                      stockQuantity: result.stockQuantity,
                    }
                  : p,
              ),
            };
          },
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'stock'] });
    },
    onError: (err) => {
      const message = formatApiError(err, 'Could not receive batch');
      setReceiveFormError(message);
      toast.error(message);
    },
  });

  const refreshProductBatches = async (productId: string) => {
    const rows = await api.products.listBatches(productId, 'all');
    setProductBatches(rows);
    return rows;
  };

  const loadBatchSummary = async (batchId: string) => {
    if (batchSummaries[batchId]) return batchSummaries[batchId];
    const summary = await api.products.batchSummary(batchId);
    setBatchSummaries((prev) => ({ ...prev, [summary.batchId]: summary }));
    return summary;
  };

  const toggleOpenBatchDetail = async (batchId: string) => {
    if (expandedBatchId === batchId) {
      setExpandedBatchId(null);
      return;
    }
    setExpandedBatchId(batchId);
    try {
      await loadBatchSummary(batchId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load batch details');
    }
  };

  const adjustBatchMut = useMutation({
    mutationFn: () =>
      api.products.adjustBatch(adjustTarget!.id, {
        remainingQuantity: parseFloat(adjustForm.remainingQuantity),
        reason: adjustForm.reason.trim(),
        markDamaged: adjustForm.markDamaged || undefined,
      }),
    onSuccess: async () => {
      toast.success('Batch adjusted');
      setAdjustTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'stock'] });
      if (selected) {
        setBatchesLoading(true);
        try {
          await refreshProductBatches(selected.id);
          setModal('batches');
        } catch {
          setModal('batches');
        } finally {
          setBatchesLoading(false);
        }
      } else {
        setModal(null);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not adjust batch');
    },
  });

  const closeOutBatchMut = useMutation({
    mutationFn: () =>
      api.products.closeOutBatch(closeOutTarget!.id, { reason: closeOutReason.trim() }),
    onSuccess: async (result) => {
      toast.success('Cylinder closed — gas loss recorded');
      setCloseOutTarget(null);
      setCloseOutReason('');
      setModal('batches');
      setBatchSummaries((prev) => ({ ...prev, [result.summary.batchId]: result.summary }));
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      if (selected) {
        setBatchesLoading(true);
        try {
          await refreshProductBatches(selected.id);
          setExpandedBatchId(result.batch.id);
        } finally {
          setBatchesLoading(false);
        }
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not close batch');
    },
  });

  const openForLooseMut = useMutation({
    mutationFn: (batchId: string) => api.products.openBatchForLoose(batchId),
    onSuccess: async () => {
      toast.success('Batch moved to open on counter');
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      setExpandedBatchSection('open');
      if (selected) {
        setBatchesLoading(true);
        try {
          await refreshProductBatches(selected.id);
        } finally {
          setBatchesLoading(false);
        }
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not open batch for loose sales');
    },
  });

  const openReceiveBatch = (p: Product) => {
    setSelected(p);
    setReceiveFormError('');
    setBatchForm({
      purchaseDate: todayIso(),
      supplier: p.supplier?.name ?? '',
      purchaseReference: '',
      purchaseCostPerBatch: '',
      batchCount: '1',
      quantityPerBatch: '',
      notes: '',
      qtyEstimated: false,
    });
    setModal('receive');
  };

  const submitReceiveBatch = () => {
    setReceiveFormError('');
    const batchCount = Math.trunc(Number(batchForm.batchCount));
    const qtyPerBatch = parseFloat(batchForm.quantityPerBatch);
    const costPerBatch = parseFloat(batchForm.purchaseCostPerBatch);
    if (!batchForm.purchaseDate) {
      setReceiveFormError('Purchase date is required');
      return;
    }
    if (!Number.isFinite(batchCount) || batchCount < 1 || !Number.isInteger(batchCount)) {
      setReceiveFormError('Enter how many batches you are receiving (whole number)');
      return;
    }
    if (batchCount > 500) {
      setReceiveFormError('Cannot receive more than 500 batches at once');
      return;
    }
    if (!Number.isFinite(qtyPerBatch) || qtyPerBatch <= 0) {
      setReceiveFormError(`Enter how much ${selected?.unit ?? 'stock'} is in each batch`);
      return;
    }
    if (!Number.isFinite(costPerBatch) || costPerBatch <= 0) {
      setReceiveFormError('Enter what you paid for one batch');
      return;
    }
    if (selected) {
      const wholeSell = parseFloat(selected.batchSellPrice ?? selected.sellPrice);
      if (Number.isFinite(wholeSell) && costPerBatch > wholeSell) {
        setReceiveFormError(
          `Purchase cost (${formatMoney(costPerBatch, currency)}) cannot exceed whole batch sell price (${formatMoney(wholeSell, currency)})`,
        );
        return;
      }
      const retail = parseFloat(selected.sellPrice);
      const costPerUnit = costPerBatch / qtyPerBatch;
      if (Number.isFinite(retail) && costPerUnit > retail) {
        setReceiveFormError(
          `Cost per ${selected.unit} (${formatMoney(costPerUnit, currency)}) exceeds retail rate (${formatMoney(retail, currency)})`,
        );
        return;
      }
    }
    receiveBatchMut.mutate();
  };

  const receiveBatchCount = Number(batchForm.batchCount);
  const receiveQtyPerBatch = parseFloat(batchForm.quantityPerBatch);
  const receiveTotalQty =
    Number.isFinite(receiveBatchCount) &&
    receiveBatchCount > 0 &&
    Number.isFinite(receiveQtyPerBatch) &&
    receiveQtyPerBatch > 0
      ? receiveBatchCount * receiveQtyPerBatch
      : null;
  const receiveTotalSpend =
    receiveTotalQty != null &&
    Number.isFinite(parseFloat(batchForm.purchaseCostPerBatch)) &&
    parseFloat(batchForm.purchaseCostPerBatch) > 0
      ? receiveBatchCount * parseFloat(batchForm.purchaseCostPerBatch)
      : null;

  const openBatches = async (p: Product) => {
    setSelected(p);
    setModal('batches');
    setExpandedBatchId(null);
    setExpandedBatchSection(null);
    setBatchesLoading(true);
    try {
      const rows = await refreshProductBatches(p.id);
      const warehouseCount = rows.filter((b) => b.status === 'WAREHOUSE').length;
      const openCount = rows.filter((b) => b.status === 'OPEN').length;
      setExpandedBatchSection(warehouseCount > 0 ? 'warehouse' : openCount > 0 ? 'open' : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load batches');
      setProductBatches([]);
      setBatchSummaries({});
    } finally {
      setBatchesLoading(false);
    }
  };

  const openCloseOutBatch = (b: ProductBatch) => {
    setCloseOutTarget(b);
    setCloseOutReason('');
    setModal('close-batch');
  };

  const openAdjustBatch = (b: ProductBatch) => {
    setAdjustTarget(b);
    setAdjustForm({
      remainingQuantity: formatDecimalInput(b.remainingQuantity),
      reason: '',
      markDamaged: false,
    });
    setModal('adjust-batch');
  };

  const importProducts = useMutation({
    mutationFn: () => api.products.importCsv({ rows: importRows, updateExisting: true }),
    onSuccess: (result) => {
      setImportResult(
        `Imported ${result.created} new, updated ${result.updated}, skipped ${result.skipped}.` +
          (result.errors.length > 0 ? ` ${result.errors.length} row(s) had errors.` : ''),
      );
      setImportRows([]);
      setImportPreview(null);
      setImportRawRows(null);
      setImportHeaders([]);
      setImportMapping({});
      setImportUnmatched([]);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
    },
    onError: (err) => {
      setImportResult(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Import failed. Try a smaller file or check your connection.',
      );
    },
  });

  const purgeAll = useMutation({
    mutationFn: () => api.products.purgeAll(),
    onSuccess: (result) => {
      setPurgeOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stock-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      setImportResult(`Removed ${result.deleted} product(s) from inventory.`);
    },
  });

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const all = await api.products.list({ pageSize: 5000 });
      const rows = [[...INVENTORY_CSV_HEADERS], ...all.data.map((p) => productToCsvRow(p))];
      downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } finally {
      setExporting(false);
    }
  };

  const resetImportState = () => {
    importParseGen.current += 1;
    setImportOpen(false);
    setImportPreview(null);
    setImportRows([]);
    setImportRawRows(null);
    setImportHeaders([]);
    setImportMapping({});
    setImportUnmatched([]);
    setImportParsing(false);
  };

  const applyImportMapping = (rows: string[][], mapping: InventoryCsvColumnMapping) => {
    const { products, errors, unmatchedHeaders, missingRequired, truncated } =
      csvRowsToImportProducts(rows, mapping);
    setImportRows(products);
    setImportUnmatched(unmatchedHeaders);
    const msgs = [...errors];
    if (missingRequired.length > 0) {
      msgs.unshift(`Map required fields first: ${missingRequired.join(', ')}.`);
    }
    if (truncated && !msgs.some((m) => m.includes('first'))) {
      msgs.unshift(`Only first ${CSV_IMPORT_MAX_ROWS} rows will be imported.`);
    }
    setImportPreview({ count: products.length, errors: msgs });
  };

  // Remap after user changes dropdowns — debounced so rapid clicks don't freeze UI.
  useEffect(() => {
    if (!importRawRows || !importOpen) return;
    if (skipMapEffect.current) {
      skipMapEffect.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      await yieldToUi();
      if (cancelled) return;
      applyImportMapping(importRawRows, debouncedImportMapping);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on debounced mapping
  }, [debouncedImportMapping, importRawRows, importOpen]);

  const handleCsvFile = async (file: File) => {
    const gen = ++importParseGen.current;
    setImportResult(null);
    setImportOpen(true);
    setImportParsing(true);
    setImportPreview(null);
    setImportRows([]);
    setImportRawRows(null);
    setImportHeaders([]);
    setImportMapping({});
    setImportUnmatched([]);

    try {
      if (file.size > CSV_IMPORT_MAX_BYTES) {
        if (importParseGen.current !== gen) return;
        setImportPreview({
          count: 0,
          errors: [
            `File is too large (${Math.ceil(file.size / (1024 * 1024))} MB). Max allowed is ${Math.floor(CSV_IMPORT_MAX_BYTES / (1024 * 1024))} MB. Split the CSV and import in parts.`,
          ],
        });
        return;
      }

      const text = await file.text();
      if (importParseGen.current !== gen) return;
      await yieldToUi();
      if (importParseGen.current !== gen) return;

      const parsed = await parseCsvFileText(text);
      if (importParseGen.current !== gen) return;

      if (parsed.length === 0) {
        setImportPreview({ count: 0, errors: ['CSV file is empty'] });
        return;
      }

      const headers = parsed[0]!.map((h) => h.trim());
      const result = csvRowsToImportProducts(parsed);
      if (importParseGen.current !== gen) return;

      skipMapEffect.current = true;
      setImportRawRows(parsed);
      setImportHeaders(headers);
      setImportMapping(result.mapping);
      setImportUnmatched(result.unmatchedHeaders);
      setImportRows(result.products);
      setImportPreview({
        count: result.products.length,
        errors:
          result.missingRequired.length > 0
            ? [
                `Could not auto-match: ${result.missingRequired.join(', ')}. Choose the correct CSV column for each field below.`,
                ...result.errors.filter((e) => !e.startsWith('Required columns')),
              ]
            : result.errors,
      });
    } catch {
      if (importParseGen.current !== gen) return;
      setImportPreview({
        count: 0,
        errors: ['Could not read this CSV. Save it as UTF-8 CSV and try again.'],
      });
    } finally {
      if (importParseGen.current === gen) setImportParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const setFieldMapping = (field: InventoryCsvField, columnIndex: number) => {
    setImportMapping((prev) => {
      const next: InventoryCsvColumnMapping = { ...prev };
      if (columnIndex >= 0) {
        for (const key of Object.keys(next) as InventoryCsvField[]) {
          if (next[key] === columnIndex) delete next[key];
        }
        next[field] = columnIndex;
      } else {
        delete next[field];
      }
      return next;
    });
  };

  const downloadTemplate = () => {
    downloadCsv('inventory-template.csv', [
      [...INVENTORY_CSV_HEADERS],
      [
        'Sample Product',
        'SKU001',
        '8901234567890',
        '500',
        '350',
        'pcs',
        'General',
        '',
        '',
        '100',
        '10',
        'true',
        '',
      ],
    ]);
  };

  const columnSelectOptions = useMemo(() => {
    const opts = [{ value: '-1', label: '— Skip / not in file —' }];
    importHeaders.forEach((h, i) => {
      opts.push({ value: String(i), label: h || `(Column ${i + 1})` });
    });
    return opts;
  }, [importHeaders]);

  const requiredMapped = INVENTORY_CSV_FIELD_META.filter((f) => f.required).every(
    (f) => importMapping[f.field] != null && importMapping[f.field]! >= 0,
  );

  const bulkAssignPart = useMutation({
    mutationFn: () =>
      api.shopParts.bulkAssignProducts({
        productIds: [...selectedProductIds],
        partId: bulkAssignPartId || null,
      }),
    onSuccess: (result) => {
      setBulkAssignOpen(false);
      setSelectedProductIds(new Set());
      toast.success(`${result.updated} product(s) assigned`);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not assign products');
    },
  });

  const toggleProductSelection = (id: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openCreate = () => {
    setForm({
      name: '',
      sellPrice: '',
      costPrice: '',
      barcode: '',
      sku: '',
      imageUrl: '',
      unit: 'pcs',
      categoryId: '',
      partId: '',
      brandId: '',
      supplierId: '',
      expiryDate: '',
      trackStock: true,
      trackType: 'SIMPLE',
      batchSellPrice: '',
      dispensingLossPercent: '0',
      lowStockThreshold: '',
    });
    setSelected(null);
    setFormErrorVisible(false);
    setModal('create');
  };

  const openEdit = (p: Product) => {
    setSelected(p);
    setForm({
      name: p.name,
      sellPrice: formatDecimalInput(p.sellPrice),
      batchSellPrice: formatDecimalInput(p.batchSellPrice ?? p.sellPrice),
      costPrice: formatDecimalInput(p.costPrice),
      barcode: p.barcode ?? '',
      sku: p.sku ?? '',
      imageUrl: canUseProductImages ? (p.imageUrl ?? '') : '',
      unit: p.unit,
      categoryId: p.category?.id ?? '',
      partId: p.part?.id ?? '',
      brandId: p.brand?.id ?? '',
      supplierId: p.supplier?.id ?? '',
      expiryDate: p.expiryDate ?? '',
      trackStock: p.trackStock,
      trackType: p.trackType ?? 'SIMPLE',
      dispensingLossPercent: p.dispensingLossPercent ?? '0',
      lowStockThreshold: p.lowStockThreshold ?? '',
    });
    setFormErrorVisible(false);
    setModal('edit');
  };

  const currency = settings?.currency ?? 'PKR';

  const sellPriceNum = parseFloat(form.sellPrice);
  const batchSellPriceNum = parseFloat(form.batchSellPrice);
  const costPriceNum = parseFloat(form.costPrice);
  const lowStockNum = parseFloat(form.lowStockThreshold);
  const isBatchProduct = form.trackType === 'BATCH';
  const productFormErrors = {
    name: !form.name.trim() ? 'Name is required' : '',
    sellPrice:
      form.sellPrice.trim() === '' || !Number.isFinite(sellPriceNum) || sellPriceNum < 0
        ? isBatchProduct
          ? 'Retail rate is required'
          : 'Sell price is required'
        : '',
    batchSellPrice:
      isBatchProduct &&
      (form.batchSellPrice.trim() === '' ||
        !Number.isFinite(batchSellPriceNum) ||
        batchSellPriceNum < 0)
        ? 'Batch price is required'
        : '',
    costPrice:
      !isBatchProduct &&
      (form.costPrice.trim() === '' || !Number.isFinite(costPriceNum) || costPriceNum < 0)
        ? 'Cost price is required'
        : '',
    lowStockThreshold:
      !isBatchProduct &&
      (form.lowStockThreshold.trim() === '' ||
        !Number.isFinite(lowStockNum) ||
        lowStockNum < 0)
        ? 'Low stock threshold is required'
        : '',
  };
  const canSaveProduct =
    !productFormErrors.name &&
    !productFormErrors.sellPrice &&
    !productFormErrors.batchSellPrice &&
    !productFormErrors.costPrice &&
    !productFormErrors.lowStockThreshold;

  if (listLoading) return <PageSkeleton rows={8} />;

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={`${summary?.totalProducts ?? data?.meta.total ?? 0} products in system`}
        action={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={exporting}
                onClick={() => void handleExportCsv()}
              >
                Export CSV
              </Button>
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                Import CSV
              </Button>
              <Button onClick={openCreate}>Add product</Button>
            </div>
          ) : undefined
        }
      />

      <div className="mb-4 rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 via-white to-emerald-50 p-5 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 shrink-0 items-start gap-3 lg:max-w-[42%]">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm shadow-brand-600/30">
              <IconBox className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                Total inventory cost
              </p>
              <p className="mt-1 text-3xl font-black tracking-tight text-brand-900 tabular-nums sm:text-4xl">
                {formatMoney(summary?.inventoryValue ?? '0', currency)}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                Batch: remaining cost of warehouse + open batches · Simple: cost × qty
              </p>
            </div>
          </div>

          <div className="min-w-0 flex-1 lg:max-w-xl">
            <div className="overflow-hidden rounded-2xl border border-white/80 bg-white/70 p-3 shadow-sm backdrop-blur-sm ring-1 ring-brand-100/60">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                    Stock movement
                  </p>
                  <p className="text-[11px] text-text-muted">
                    Last {MOVEMENT_DAYS} days · qty flow
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-100">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    In {movementTotals.in.toLocaleString('en-PK', { maximumFractionDigits: 1 })}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-800 ring-1 ring-rose-100">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                    Out {movementTotals.out.toLocaleString('en-PK', { maximumFractionDigits: 1 })}
                  </span>
                </div>
              </div>

              <div className="h-28 w-full sm:h-32">
                {!hasMovement ? (
                  <div className="flex h-full items-center justify-center rounded-xl bg-surface-muted/40 text-xs text-text-muted">
                    No stock movements in the last {MOVEMENT_DAYS} days
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={movementChart}
                      margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="invInFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
                          <stop offset="55%" stopColor="#059669" stopOpacity={0.12} />
                          <stop offset="100%" stopColor="#059669" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="invOutFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#fb7185" stopOpacity={0.4} />
                          <stop offset="55%" stopColor="#e11d48" stopOpacity={0.1} />
                          <stop offset="100%" stopColor="#e11d48" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 6"
                        stroke="#d1e7e2"
                        vertical={false}
                        strokeOpacity={0.7}
                      />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: '#5f7a75', fontSize: 10, fontWeight: 600 }}
                        axisLine={false}
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={18}
                        dy={4}
                      />
                      <Tooltip
                        cursor={{ stroke: '#94a3b8', strokeDasharray: '4 4', strokeWidth: 1 }}
                        content={<MovementTooltip />}
                      />
                      <Area
                        type="monotone"
                        dataKey="in"
                        stroke="#059669"
                        strokeWidth={2.5}
                        fill="url(#invInFill)"
                        name="in"
                        activeDot={{
                          r: 4.5,
                          strokeWidth: 2,
                          stroke: '#fff',
                          fill: '#059669',
                        }}
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="out"
                        stroke="#e11d48"
                        strokeWidth={2.5}
                        fill="url(#invOutFill)"
                        name="out"
                        activeDot={{
                          r: 4.5,
                          strokeWidth: 2,
                          stroke: '#fff',
                          fill: '#e11d48',
                        }}
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isFetching && (
        <div className="mb-3" aria-busy="true" aria-label="Updating products">
          <TableSkeleton rows={3} />
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleCsvFile(file);
          e.target.value = '';
        }}
      />

      {importResult && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {importResult}
          <button type="button" className="ml-2 underline" onClick={() => setImportResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      {summary && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border bg-surface p-3 text-sm">
            <p className="text-text-muted">Healthy</p>
            <p className="text-lg font-bold">{summary.healthyCount}</p>
          </div>
          <Link
            to="/pos/inventory?stock=low"
            className="rounded-xl border bg-slate-50 p-3 text-sm transition hover:border-brand-300 hover:bg-brand-50/40"
          >
            <p className="text-text-muted">Low stock</p>
            <p className="text-lg font-bold text-slate-800">{summary.lowStockCount}</p>
            <p className="mt-1 text-[11px] font-semibold text-brand-700">View all →</p>
          </Link>
          <Link
            to="/pos/inventory?stock=out"
            className="rounded-xl border bg-rose-50 p-3 text-sm transition hover:border-rose-300 hover:bg-rose-100/60"
          >
            <p className="text-text-muted">Out of stock</p>
            <p className="text-lg font-bold text-rose-800">{summary.outOfStockCount}</p>
            <p className="mt-1 text-[11px] font-semibold text-rose-700">View all →</p>
          </Link>
          <div className="rounded-xl border bg-brand-50 p-3 text-sm">
            <p className="text-text-muted">Projected profit</p>
            <p className="text-lg font-bold text-brand-800">
              {formatMoney(summary.projectedProfit, currency)}
            </p>
          </div>
        </div>
      )}

      {(openBatchRows?.length ?? 0) > 0 && (
        <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-card)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-text">Open batches</p>
              <p className="text-xs text-text-muted">
                Remaining stock across cylinders/coils — {openBatchRows!.length} open
              </p>
            </div>
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="sticky top-0 bg-surface-muted text-xs uppercase text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-semibold">Product</th>
                  <th className="px-4 py-2 font-semibold">Remaining</th>
                  <th className="px-4 py-2 font-semibold">Paid</th>
                  <th className="px-4 py-2 font-semibold">Purchased</th>
                  <th className="px-4 py-2 font-semibold">Supplier</th>
                </tr>
              </thead>
              <tbody>
                {openBatchRows!.map((b) => (
                  <tr key={b.id} className="border-t border-border/60">
                    <td className="px-4 py-2 font-medium">{b.product?.name ?? '—'}</td>
                    <td className="px-4 py-2 font-semibold tabular-nums">
                      {formatQty(b.remainingQuantity)}
                      <span className="ml-1 font-normal text-text-muted">
                        {b.product?.unit ?? ''}
                      </span>
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatMoney(batchPurchaseTotal(b), currency)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-text-muted">{b.purchaseDate}</td>
                    <td className="px-4 py-2 text-text-muted">{b.supplier || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
        <input
          className="min-h-[44px] w-full min-w-0 flex-1 rounded-xl border border-border bg-white px-3 py-2 text-sm text-text placeholder:text-text-muted/60 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 sm:min-w-[200px]"
          placeholder="Search name, SKU, or barcode..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          inputMode="search"
          enterKeyHint="search"
        />
        <select
          className="min-h-[44px] w-full shrink-0 rounded-xl border border-border bg-white px-3 py-2 text-sm sm:w-auto sm:min-w-[140px]"
          value={stockStatus}
          onChange={(e) => applyStockStatus(e.target.value)}
        >
          <option value="all">All stock</option>
          <option value="healthy">Healthy</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        {hasFeature(user, FEATURES.INVENTORY_CATEGORIES) && (
          <select
            className="min-h-[44px] w-full shrink-0 rounded-xl border border-border bg-white px-3 py-2 text-sm sm:w-auto sm:min-w-[160px]"
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {canUseShopParts && (
          <select
            className="min-h-[44px] w-full shrink-0 rounded-xl border border-border bg-white px-3 py-2 text-sm sm:w-auto sm:min-w-[160px]"
            value={partFilter}
            onChange={(e) => {
              setPartFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All parts</option>
            <option value="none">Unassigned</option>
            {(shopParts ?? []).map((part) => (
              <option key={part.id} value={part.id}>
                {part.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {canUseShopParts && selectedProductIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
          <span className="text-sm font-medium text-text">
            {selectedProductIds.size} selected
          </span>
          <Button size="sm" onClick={() => setBulkAssignOpen(true)}>
            Assign to part
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedProductIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {displayedProducts.length === 0 ? (
        <EmptyState
          title="No products"
          description={
            search.trim()
              ? 'No products match your search.'
              : 'Add your first product to get started.'
          }
        />
      ) : (
        <>
          {/* Mobile cards */}
          <div className={`space-y-3 md:hidden ${isFetching ? 'opacity-70' : ''}`}>
            {displayedProducts.map((p) => (
              <div
                key={p.id}
                className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {canUseShopParts && canEdit && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedProductIds.has(p.id)}
                        onChange={() => toggleProductSelection(p.id)}
                      />
                    )}
                    <div className="min-w-0">
                      <p className="font-semibold text-text">{p.name}</p>
                      <p className="mt-0.5 text-xs text-text-muted">{p.barcode || p.sku || '—'}</p>
                      {p.part?.name && (
                        <p className="mt-0.5 text-xs text-brand-700">{p.part.name}</p>
                      )}
                      {p.trackType === 'BATCH' && (
                        <Badge variant="default" className="mt-1">
                          Batch · {p.unit}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Badge variant={p.isActive ? 'success' : 'default'}>
                    {p.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <p>
                    <span className="text-text-muted">Price </span>
                    {p.trackType === 'BATCH' ? (
                      <span className="block font-semibold">
                        {formatBatchProductPrice(p, currency, formatMoney).perUnit}
                        <span className="mt-0.5 block text-xs font-normal text-text-muted">
                          Whole {formatBatchProductPrice(p, currency, formatMoney).wholeBatch}
                        </span>
                      </span>
                    ) : (
                      <span className="font-semibold">{formatMoney(p.sellPrice, currency)}</span>
                    )}
                  </p>
                  <p>
                    <span className="text-text-muted">Stock </span>
                    <span
                      className={
                        getStockStatus(p) === 'low' ? 'font-semibold text-warning' : 'font-semibold'
                      }
                    >
                      {formatProductStock(p)}
                    </span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {canEdit && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => openEdit(p)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() => setDeleteTarget(p)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  {canAdjust && p.trackStock && p.trackType !== 'BATCH' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelected(p);
                        setStockDelta('');
                        setModal('stock');
                      }}
                    >
                      Stock
                    </Button>
                  )}
                  {canAdjust && p.trackStock && p.trackType === 'BATCH' && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => openReceiveBatch(p)}>
                        Receive batch
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openBatches(p)}>
                        Batches
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div
            className={`hidden overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-card)] md:block ${isFetching ? 'opacity-70' : ''}`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {canUseShopParts && canEdit && <th className="px-4 py-3 w-10" />}
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Price</th>
                    <th className="px-4 py-3">Stock</th>
                    {canUseShopParts && <th className="px-4 py-3">Part</th>}
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {displayedProducts.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 hover:bg-brand-50/30">
                      {canUseShopParts && canEdit && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedProductIds.has(p.id)}
                            onChange={() => toggleProductSelection(p.id)}
                          />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <p className="font-medium text-text">{p.name}</p>
                        <p className="text-xs text-text-muted">{p.barcode || p.sku || '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        {p.trackType === 'BATCH' ? (
                          <div>
                            <p className="font-semibold">
                              {formatBatchProductPrice(p, currency, formatMoney).perUnit}
                            </p>
                            <p className="text-xs font-normal text-text-muted">
                              Whole {formatBatchProductPrice(p, currency, formatMoney).wholeBatch}
                            </p>
                          </div>
                        ) : (
                          <span className="font-semibold">{formatMoney(p.sellPrice, currency)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {p.trackStock ? (
                          <span
                            className={
                              getStockStatus(p) === 'low' ? 'text-warning font-semibold' : ''
                            }
                          >
                            {formatProductStock(p)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      {canUseShopParts && (
                        <td className="px-4 py-3 text-text-muted">{p.part?.name ?? '—'}</td>
                      )}
                      <td className="px-4 py-3">
                        <Badge variant={p.isActive ? 'success' : 'default'}>
                          {p.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canEdit && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger"
                              onClick={() => setDeleteTarget(p)}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                        {canAdjust && p.trackStock && p.trackType !== 'BATCH' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSelected(p);
                              setStockDelta('');
                              setModal('stock');
                            }}
                          >
                            Stock
                          </Button>
                        )}
                        {canAdjust && p.trackStock && p.trackType === 'BATCH' && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openReceiveBatch(p)}>
                              Receive
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void openBatches(p)}
                            >
                              Batches
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {meta ? (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              pageSize={meta.pageSize}
              onPageChange={setPage}
            />
          ) : null}
        </>
      )}

      <Modal
        open={modal === 'create' || modal === 'edit'}
        onClose={() => setModal(null)}
        title={modal === 'edit' ? 'Edit product' : 'New product'}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="inventory-product-form"
              loading={saveProduct.isPending}
              onClick={() => {
                if (!canSaveProduct) {
                  setFormErrorVisible(true);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          id="inventory-product-form"
          className="space-y-4"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (e.target instanceof HTMLTextAreaElement) return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'BUTTON') return;
            const fields = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'input:not([type="hidden"]):not([type="checkbox"]):not([type="file"]):not([disabled]), select:not([disabled])',
              ),
            );
            const index = fields.indexOf(e.target as HTMLElement);
            if (index >= 0 && index < fields.length - 1) {
              e.preventDefault();
              fields[index + 1]?.focus();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSaveProduct) {
              setFormErrorVisible(true);
              return;
            }
            saveProduct.mutate();
          }}
        >
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            error={formErrorVisible ? productFormErrors.name || undefined : undefined}
          />
          <Select
            label="Track type"
            value={form.trackType}
            onChange={(e) => {
              const trackType = e.target.value as 'SIMPLE' | 'BATCH';
              const switchingToBatch =
                trackType === 'BATCH' &&
                modal === 'edit' &&
                selected?.trackType !== 'BATCH' &&
                parseFloat(selected?.stockQuantity ?? '0') > 0;
              if (switchingToBatch) {
                const ok = window.confirm(
                  'Switching to batch clears simple stock and cost from inventory value. Receive batches afterward. Continue?',
                );
                if (!ok) return;
              }
              setForm({
                ...form,
                trackType,
                batchSellPrice:
                  trackType === 'BATCH' ? form.batchSellPrice || form.sellPrice : '',
                costPrice: trackType === 'BATCH' ? '' : form.costPrice,
              });
            }}
            options={[
              { value: 'SIMPLE', label: 'Simple (spare parts)' },
              { value: 'BATCH', label: 'Batch (gas / pipe / bulk)' },
            ]}
          />
          {form.trackType === 'BATCH' && modal === 'edit' && selected?.trackType !== 'BATCH' && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              Simple stock and cost will be cleared. Inventory value will come from batches you
              receive (warehouse + open).
            </p>
          )}
          <Input
            label="Unit"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            hint="e.g. piece, kg, meter, feet"
          />
          {form.trackType === 'BATCH' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label={`Retail rate (${currency} / ${form.unit || 'unit'})`}
                type="number"
                value={form.sellPrice}
                onChange={(e) => setForm({ ...form, sellPrice: e.target.value })}
                required
                error={formErrorVisible ? productFormErrors.sellPrice || undefined : undefined}
                hint="Loose sales — price per unit (e.g. 50 PKR per meter)"
              />
              <Input
                label={`Whole batch price (${currency})`}
                type="number"
                value={form.batchSellPrice}
                onChange={(e) => setForm({ ...form, batchSellPrice: e.target.value })}
                required
                error={formErrorVisible ? productFormErrors.batchSellPrice || undefined : undefined}
                hint="Fixed price for selling the entire batch (e.g. 3000 PKR for the full coil)"
              />
            </div>
          ) : (
            <>
              <Input
                label="Sell price"
                type="number"
                value={form.sellPrice}
                onChange={(e) => setForm({ ...form, sellPrice: e.target.value })}
                required
                error={formErrorVisible ? productFormErrors.sellPrice || undefined : undefined}
              />
              <Input
                label="Cost price"
                type="number"
                value={form.costPrice}
                onChange={(e) => setForm({ ...form, costPrice: e.target.value })}
                required
                error={formErrorVisible ? productFormErrors.costPrice || undefined : undefined}
              />
            </>
          )}
          <Input
            label="Barcode"
            value={form.barcode}
            onChange={(e) => setForm({ ...form, barcode: e.target.value })}
          />
          <Input
            label="SKU"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
          />
          {canUseProductImages && (
            <div className="rounded-xl border border-border bg-surface-muted/40 p-3">
              <p className="mb-1.5 text-xs font-medium text-text">Product image</p>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="block w-full text-sm text-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-800"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (!PRODUCT_IMAGE_TYPES.has(file.type)) {
                    toast.error('Choose a PNG, JPEG, or WebP image.');
                    e.target.value = '';
                    return;
                  }
                  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
                    toast.error('Product image must be under 500KB.');
                    e.target.value = '';
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () =>
                    setForm((current) => ({
                      ...current,
                      imageUrl: String(reader.result ?? ''),
                    }));
                  reader.onerror = () => toast.error('Could not read the selected image.');
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
              {form.imageUrl && (
                <div className="mt-3 flex items-center gap-3">
                  <img
                    src={form.imageUrl}
                    alt="Product preview"
                    className="h-20 w-20 rounded-xl border border-border bg-white object-cover"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => setForm({ ...form, imageUrl: '' })}
                  >
                    Clear image
                  </Button>
                </div>
              )}
              <p className="mt-2 text-[11px] text-text-muted">PNG, JPEG, or WebP · max 500KB</p>
            </div>
          )}
          <Input
            label="Expiry date"
            type="date"
            value={form.expiryDate}
            onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
          />
          {hasFeature(user, FEATURES.INVENTORY_CATEGORIES) && (
            <select
              className="w-full rounded-xl border border-border px-3 py-2 text-sm"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">No category</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {canUseShopParts && (
            <select
              className="w-full rounded-xl border border-border px-3 py-2 text-sm"
              value={form.partId}
              onChange={(e) => setForm({ ...form, partId: e.target.value })}
            >
              <option value="">No shop part</option>
              {(shopParts ?? []).map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                </option>
              ))}
            </select>
          )}
          {hasFeature(user, FEATURES.INVENTORY_BRANDS) && (
            <select
              className="w-full rounded-xl border border-border px-3 py-2 text-sm"
              value={form.brandId}
              onChange={(e) => setForm({ ...form, brandId: e.target.value })}
            >
              <option value="">No brand</option>
              {(brands ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {hasFeature(user, FEATURES.INVENTORY_SUPPLIERS) && (
            <select
              className="w-full rounded-xl border border-border px-3 py-2 text-sm"
              value={form.supplierId}
              onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
            >
              <option value="">No supplier</option>
              {(suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.trackStock}
              onChange={(e) => setForm({ ...form, trackStock: e.target.checked })}
            />
            Track stock
          </label>
          <Input
            label={isBatchProduct ? 'Low stock threshold (batches)' : 'Low stock threshold'}
            type="number"
            value={form.lowStockThreshold}
            onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
            required={!isBatchProduct}
            hint={
              isBatchProduct
                ? 'Alert when available batch count falls below this (e.g. 2 batches left)'
                : undefined
            }
            error={formErrorVisible ? productFormErrors.lowStockThreshold || undefined : undefined}
          />
        </form>
      </Modal>

      <Modal
        open={modal === 'stock'}
        onClose={() => setModal(null)}
        title={`Adjust stock — ${selected?.name}`}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button type="submit" form="inventory-stock-form" loading={adjustStock.isPending}>
              Apply
            </Button>
          </>
        }
      >
        <form
          id="inventory-stock-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!stockDelta.trim() || !Number.isFinite(parseFloat(stockDelta))) return;
            adjustStock.mutate();
          }}
        >
          <p className="mb-3 text-sm text-text-muted">
            Current: {formatQty(selected?.stockQuantity)}
          </p>
          <Input
            label="Quantity change (+/-)"
            type="number"
            value={stockDelta}
            onChange={(e) => setStockDelta(e.target.value)}
            required
            hint="Press Enter to save"
          />
        </form>
      </Modal>

      <Modal
        open={modal === 'receive'}
        onClose={() => {
          setModal(null);
          setReceiveFormError('');
        }}
        title={`Receive batch — ${selected?.name}`}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={receiveBatchMut.isPending}
              onClick={submitReceiveBatch}
            >
              {receiveBatchMut.isPending && Number(batchForm.batchCount) > 1
                ? 'Receiving…'
                : 'Receive'}
            </Button>
          </>
        }
      >
        <form
          id="inventory-receive-batch-form"
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submitReceiveBatch();
          }}
        >
          {receiveFormError ? (
            <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {receiveFormError}
            </p>
          ) : null}
          {selected && (
            <p className="text-sm text-text-muted">
              Retail {formatMoney(selected.sellPrice, currency)}/{selected.unit} · Whole batch{' '}
              {formatMoney(selected.batchSellPrice ?? '0', currency)}
            </p>
          )}
          <Input
            label="Purchase date"
            type="date"
            value={batchForm.purchaseDate}
            onChange={(e) => setBatchForm({ ...batchForm, purchaseDate: e.target.value })}
            required
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Number of batches"
              type="number"
              step="1"
              min="1"
              value={batchForm.batchCount}
              onChange={(e) => setBatchForm({ ...batchForm, batchCount: e.target.value })}
              required
              hint="How many coils/cylinders you received"
            />
            <Input
              label={`Quantity per batch (${selected?.unit ?? 'units'})`}
              type="number"
              step="0.001"
              min="0.001"
              value={batchForm.quantityPerBatch}
              onChange={(e) => setBatchForm({ ...batchForm, quantityPerBatch: e.target.value })}
              required
              hint={`${selected?.unit ?? 'Units'} inside each batch`}
            />
          </div>
          {receiveTotalQty != null && (
            <p className="rounded-lg border border-border bg-surface-muted/60 px-3 py-2 text-sm text-text-muted">
              Receiving{' '}
              <span className="font-semibold text-text">
                {receiveBatchCount} batch{receiveBatchCount === 1 ? '' : 'es'} × {receiveQtyPerBatch}{' '}
                {selected?.unit ?? 'units'}
              </span>{' '}
              ={' '}
              <span className="font-semibold text-text">
                {receiveTotalQty} {selected?.unit ?? 'units'} total
              </span>
            </p>
          )}
          <Input
            label={`Purchase cost per batch (${currency})`}
            type="number"
            step="0.01"
            min="0.01"
            value={batchForm.purchaseCostPerBatch}
            onChange={(e) =>
              setBatchForm({ ...batchForm, purchaseCostPerBatch: e.target.value })
            }
            required
            hint="What you paid for one coil/cylinder — same price for each batch"
          />
          {receiveTotalSpend != null && receiveBatchCount > 1 && (
            <p className="text-xs text-text-muted">
              Total paid: {formatMoney(receiveTotalSpend, currency)} ({receiveBatchCount} ×{' '}
              {formatMoney(batchForm.purchaseCostPerBatch, currency)})
            </p>
          )}
          <Input
            label="Supplier"
            value={batchForm.supplier}
            onChange={(e) => setBatchForm({ ...batchForm, supplier: e.target.value })}
          />
          <Input
            label="Purchase reference"
            value={batchForm.purchaseReference}
            onChange={(e) => setBatchForm({ ...batchForm, purchaseReference: e.target.value })}
            hint="Invoice / delivery note #"
          />
          <Input
            label="Notes"
            value={batchForm.notes}
            onChange={(e) => setBatchForm({ ...batchForm, notes: e.target.value })}
          />
          <label className="flex items-start gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              className="mt-1"
              checked={batchForm.qtyEstimated}
              onChange={(e) => setBatchForm({ ...batchForm, qtyEstimated: e.target.checked })}
            />
            <span>Quantity per batch is an estimate — adjust later after weighing</span>
          </label>
        </form>
      </Modal>

      <Modal
        open={modal === 'batches'}
        onClose={() => setModal(null)}
        title={`Batches — ${selected?.name}`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              Close
            </Button>
            {canAdjust && selected && (
              <Button
                onClick={() => {
                  if (selected) openReceiveBatch(selected);
                }}
              >
                Receive batch
              </Button>
            )}
          </>
        }
      >
        {batchesLoading ? (
          <PageSkeleton rows={4} />
        ) : productBatches.length === 0 ? (
          <EmptyState
            title="No batches yet"
            description="Receive a cylinder or coil to start tracking this product by batch."
          />
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                expandedBatchSection === 'warehouse'
                  ? 'border-brand-300 bg-brand-50'
                  : 'border-border bg-surface hover:bg-surface-muted/50'
              }`}
              onClick={() =>
                setExpandedBatchSection((prev) => (prev === 'warehouse' ? null : 'warehouse'))
              }
            >
              <div>
                <p className="font-semibold text-text">In stock</p>
                <p className="text-xs text-text-muted">
                  Received — not opened yet. Tap to open on counter when ready.
                </p>
              </div>
              <span className="text-2xl font-bold tabular-nums text-brand-700">
                {warehouseProductBatches.length}
              </span>
            </button>

            {expandedBatchSection === 'warehouse' && (
              <div className="overflow-x-auto rounded-xl border border-border">
                {warehouseProductBatches.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-text-muted">No batches in stock.</p>
                ) : (
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted/40 text-xs uppercase text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-semibold">Purchased</th>
                        <th className="px-2 py-2 font-semibold">Remaining</th>
                        <th className="px-2 py-2 font-semibold">Paid</th>
                        <th className="px-2 py-2 font-semibold">Supplier</th>
                        {canAdjust && <th className="px-2 py-2 font-semibold"> </th>}
                      </tr>
                    </thead>
                    <tbody>
                      {warehouseProductBatches.map((b) => {
                        const summary = batchSummaries[b.id];
                        const expanded = expandedBatchId === b.id;
                        return (
                          <Fragment key={b.id}>
                            <tr className="border-b border-border/60">
                              <td className="px-2 py-2 tabular-nums">{b.purchaseDate}</td>
                              <td className="px-2 py-2 font-semibold tabular-nums">
                                {formatQty(b.remainingQuantity)}
                                <span className="ml-1 font-normal text-text-muted">
                                  / {formatQty(b.initialQuantity)} {selected?.unit}
                                </span>
                              </td>
                              <td className="px-2 py-2 tabular-nums">
                                {formatMoney(batchPurchaseTotal(b), currency)}
                              </td>
                              <td className="px-2 py-2 text-text-muted">
                                {b.supplier || b.purchaseReference || '—'}
                              </td>
                              {canAdjust && (
                                <td className="px-2 py-2 text-right">
                                  <div className="flex flex-wrap items-center justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void toggleOpenBatchDetail(b.id)}
                                    >
                                      {expanded ? 'Hide' : 'Details'}
                                    </Button>
                                    {parseFloat(b.remainingQuantity) > 0 && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        loading={openForLooseMut.isPending}
                                        onClick={() => openForLooseMut.mutate(b.id)}
                                      >
                                        Open on counter
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => openAdjustBatch(b)}
                                    >
                                      Adjust
                                    </Button>
                                  </div>
                                </td>
                              )}
                            </tr>
                            {expanded && summary && (
                              <tr className="border-b border-border/60 bg-surface-muted/40">
                                <td colSpan={canAdjust ? 5 : 4} className="px-4 py-3">
                                  <BatchProfitPanel
                                    summary={summary}
                                    currency={currency}
                                    unit={selected?.unit ?? summary.unit}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            <button
              type="button"
              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                expandedBatchSection === 'open'
                  ? 'border-emerald-300 bg-emerald-50'
                  : 'border-border bg-surface hover:bg-surface-muted/50'
              }`}
              onClick={() =>
                setExpandedBatchSection((prev) => (prev === 'open' ? null : 'open'))
              }
            >
              <div>
                <p className="font-semibold text-text">Open on counter</p>
                <p className="text-xs text-text-muted">Opened for loose sales — tap for details</p>
              </div>
              <span className="text-2xl font-bold tabular-nums text-emerald-700">
                {openCounterBatches.length}
              </span>
            </button>

            {expandedBatchSection === 'open' && (
              <div className="overflow-x-auto rounded-xl border border-border">
                {openCounterBatches.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-text-muted">No batches open on counter.</p>
                ) : (
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted/40 text-xs uppercase text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-semibold">Purchased</th>
                        <th className="px-2 py-2 font-semibold">Remaining</th>
                        <th className="px-2 py-2 font-semibold">Paid</th>
                        <th className="px-2 py-2 font-semibold">Supplier</th>
                        {canAdjust && <th className="px-2 py-2 font-semibold"> </th>}
                      </tr>
                    </thead>
                    <tbody>
                      {openCounterBatches.map((b) => {
                        const summary = batchSummaries[b.id];
                        const expanded = expandedBatchId === b.id;
                        return (
                          <Fragment key={b.id}>
                            <tr className="border-b border-border/60">
                              <td className="px-2 py-2 tabular-nums">{b.purchaseDate}</td>
                              <td className="px-2 py-2 font-semibold tabular-nums">
                                {formatQty(b.remainingQuantity)}
                                <span className="ml-1 font-normal text-text-muted">
                                  / {formatQty(b.initialQuantity)} {selected?.unit}
                                </span>
                              </td>
                              <td className="px-2 py-2 tabular-nums">
                                {formatMoney(batchPurchaseTotal(b), currency)}
                              </td>
                              <td className="px-2 py-2 text-text-muted">
                                {b.supplier || b.purchaseReference || '—'}
                              </td>
                              {canAdjust && (
                                <td className="px-2 py-2 text-right">
                                  <div className="flex flex-wrap items-center justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void toggleOpenBatchDetail(b.id)}
                                    >
                                      {expanded ? 'Hide' : 'Details'}
                                    </Button>
                                    {parseFloat(b.remainingQuantity) > 0 && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => openCloseOutBatch(b)}
                                      >
                                        Close cylinder
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => openAdjustBatch(b)}
                                    >
                                      Adjust
                                    </Button>
                                  </div>
                                </td>
                              )}
                            </tr>
                            {expanded && summary && (
                              <tr className="border-b border-border/60 bg-surface-muted/40">
                                <td colSpan={canAdjust ? 5 : 4} className="px-4 py-3">
                                  <BatchProfitPanel
                                    summary={summary}
                                    currency={currency}
                                    unit={selected?.unit ?? summary.unit}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={modal === 'close-batch'}
        onClose={() => {
          setModal('batches');
          setCloseOutTarget(null);
          setCloseOutReason('');
        }}
        title={`Close cylinder — ${selected?.name ?? ''}`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setModal('batches');
                setCloseOutTarget(null);
                setCloseOutReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={closeOutBatchMut.isPending}
              disabled={closeOutReason.trim().length < 3}
              onClick={() => closeOutBatchMut.mutate()}
            >
              Write off gas & close
            </Button>
          </>
        }
      >
        {closeOutTarget && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              Bought {closeOutTarget.purchaseDate} ·{' '}
              <strong className="text-text">
                {formatQty(closeOutTarget.remainingQuantity)} {selected?.unit}
              </strong>{' '}
              remaining will be written off as gas loss and this cylinder will be closed.
            </p>
            <div className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-950">
              Cost impact:{' '}
              {formatMoney(
                (
                  parseFloat(closeOutTarget.remainingQuantity) *
                  parseFloat(closeOutTarget.costPerUnit)
                ).toFixed(2),
                currency,
              )}{' '}
              — included in batch profit and shop COGS when closed.
            </div>
            <Input
              label="Reason"
              value={closeOutReason}
              onChange={(e) => setCloseOutReason(e.target.value)}
              required
              hint='e.g. "Cylinder empty — 0.45 kg remaining in line/hose loss"'
            />
          </div>
        )}
      </Modal>

      <Modal
        open={modal === 'adjust-batch'}
        onClose={() => {
          setModal('batches');
          setAdjustTarget(null);
        }}
        title={`Adjust batch — ${selected?.name ?? ''}`}
        footer={
          <>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setModal('batches');
                setAdjustTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="inventory-adjust-batch-form"
              loading={adjustBatchMut.isPending}
            >
              Save adjustment
            </Button>
          </>
        }
      >
        {adjustTarget && (
          <form
            id="inventory-adjust-batch-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const qty = parseFloat(adjustForm.remainingQuantity);
              if (!Number.isFinite(qty) || qty < 0) return;
              if (adjustForm.reason.trim().length < 3) {
                toast.error('Enter a reason (at least 3 characters)');
                return;
              }
              adjustBatchMut.mutate();
            }}
          >
            <p className="text-sm text-text-muted">
              Bought {adjustTarget.purchaseDate} · booked initial{' '}
              {formatQty(adjustTarget.initialQuantity)} {selected?.unit}. Current remaining{' '}
              <strong className="text-text">{formatQty(adjustTarget.remainingQuantity)}</strong>.
            </p>
            <div className="rounded-lg border border-brand-200 bg-brand-50/70 px-3 py-2 text-xs text-brand-950">
              Use this after you physically weigh/measure. Set the real remaining qty — this is{' '}
              <strong>not</strong> a sale and will not appear on customer receipts.
            </div>
            <Input
              label={`Corrected remaining (${selected?.unit ?? 'units'})`}
              type="number"
              step="0.001"
              value={adjustForm.remainingQuantity}
              onChange={(e) =>
                setAdjustForm({ ...adjustForm, remainingQuantity: e.target.value })
              }
              required
            />
            <Input
              label="Reason"
              value={adjustForm.reason}
              onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
              required
              hint='e.g. "Weighed cylinder — actual net 12.85 kg"'
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adjustForm.markDamaged}
                onChange={(e) =>
                  setAdjustForm({ ...adjustForm, markDamaged: e.target.checked })
                }
              />
              Mark batch as damaged
            </label>
          </form>
        )}
      </Modal>

      {canEdit && (data?.meta.total ?? 0) > 0 && (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50/50 p-4">
          <p className="text-sm font-semibold text-rose-900">Danger zone</p>
          <p className="mt-1 text-xs text-rose-800">
            Remove all products from inventory. Sales history is kept. Export CSV first if you need
            a backup.
          </p>
          <Button className="mt-3" variant="danger" size="sm" onClick={() => setPurgeOpen(true)}>
            Clear all inventory
          </Button>
        </div>
      )}

      <Modal
        open={importOpen}
        onClose={resetImportState}
        title="Import inventory from CSV"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={downloadTemplate}>
              Download template
            </Button>
            <Button variant="ghost" onClick={resetImportState}>
              Cancel
            </Button>
            <Button
              loading={importProducts.isPending}
              disabled={
                importParsing || !importPreview || importPreview.count === 0 || !requiredMapped
              }
              onClick={() => importProducts.mutate()}
            >
              Import {importPreview?.count ?? 0} product(s)
            </Button>
          </>
        }
      >
        {importParsing ? (
          <div className="space-y-3 py-6 text-center text-sm text-text-muted">
            <PageSkeleton rows={4} />
            <p>Reading and matching CSV columns…</p>
          </div>
        ) : importPreview ? (
          <div className="space-y-4 text-sm">
            <p>
              Ready to import <strong>{importPreview.count}</strong> product row(s)
              {importPreview.count >= CSV_IMPORT_MAX_ROWS ? ` (max ${CSV_IMPORT_MAX_ROWS})` : ''}.
              Existing products match by SKU or barcode and will be updated.
            </p>

            {importHeaders.length > 0 && (
              <div className="rounded-xl border border-border bg-surface-muted/40 p-3">
                <p className="font-semibold text-text">Match your CSV columns</p>
                <p className="mt-1 text-xs text-text-muted">
                  Headings were auto-matched where possible. Fix any wrong matches below so prices
                  and names do not import into the wrong fields.
                </p>
                <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
                  {INVENTORY_CSV_FIELD_META.map((meta) => (
                    <Select
                      key={meta.field}
                      label={`${meta.label}${meta.required ? ' *' : ''}`}
                      options={columnSelectOptions}
                      value={String(importMapping[meta.field] ?? -1)}
                      onChange={(e) => setFieldMapping(meta.field, Number(e.target.value))}
                    />
                  ))}
                </div>
                {importUnmatched.length > 0 && (
                  <p className="mt-3 text-xs text-text-muted">
                    Unused CSV columns (ignored): {importUnmatched.join(', ')}
                  </p>
                )}
              </div>
            )}

            {importPreview.errors.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
                <p className="font-medium">Parse warnings ({importPreview.errors.length})</p>
                <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-y-auto pl-4 text-xs">
                  {importPreview.errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {!requiredMapped && (
              <p className="text-xs font-medium text-danger">
                Map Product name and Sell price before importing.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-muted">Select a CSV file to preview import.</p>
        )}
      </Modal>

      <Modal
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        title="Assign products to shop part"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkAssignOpen(false)}>
              Cancel
            </Button>
            <Button loading={bulkAssignPart.isPending} onClick={() => bulkAssignPart.mutate()}>
              Assign {selectedProductIds.size} product(s)
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-text-muted">
          Past sales for these products will also appear under the selected part.
        </p>
        <select
          className="w-full rounded-xl border border-border px-3 py-2 text-sm"
          value={bulkAssignPartId}
          onChange={(e) => setBulkAssignPartId(e.target.value)}
        >
          <option value="">Unassigned (remove part)</option>
          {(shopParts ?? []).map((part) => (
            <option key={part.id} value={part.id}>
              {part.name}
            </option>
          ))}
        </select>
      </Modal>

      <ConfirmDialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        onConfirm={() => purgeAll.mutate()}
        title="Clear all inventory?"
        message="This removes every product from your shop database. Sales records are not deleted. Export CSV first if you need a backup."
        confirmLabel="Clear all products"
        loading={purgeAll.isPending}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteProduct.mutate(deleteTarget.id);
        }}
        title="Delete product"
        message={
          deleteTarget ? (
            <>
              Delete <strong className="text-text">{deleteTarget.name}</strong>? It will be removed
              from inventory and sales search. This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete product"
        loading={deleteProduct.isPending}
      />
    </div>
  );
}
