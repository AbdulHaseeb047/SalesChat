import type {
  ApiErrorBody,
  AuthUser,
  Branch,
  Brand,
  BusinessSettings,
  Category,
  CreateSaleResponse,
  Customer,
  DailySalesReport,
  DashboardSummary,
  DiscountRule,
  DiscountUsageRow,
  FeatureRegistryItem,
  FinancialEntry,
  FinancialSummary,
  GiftCard,
  HeldCart,
  InventorySummary,
  LedgerEntry,
  LoginResponse,
  Paginated,
  Product,
  ProductBatch,
  BatchSummary,
  SaleDetail,
  SaleListItem,
  SalesSummaryReport,
  ShopPart,
  ShopPartsSummaryReport,
  Supplier,
  SupplierLedgerEntry,
  SyncIssue,
  SyncStatus,
  AdminDashboard,
  SalesRep,
  TenantDetail,
  TenantRow,
  TenantUser,
  UdhaarAgingRow,
} from '@/types/api';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '/api').replace(/\/$/, '');

/** Non-secret flag so the UI knows a cookie session may exist (tokens stay httpOnly). */
const STORAGE_SESSION = 'pos_session';
const STORAGE_BRANCH = 'pos_branch_id';
/** Legacy keys — cleared on login/logout so tokens are never left in localStorage. */
const LEGACY_ACCESS = 'pos_access_token';
const LEGACY_REFRESH = 'pos_refresh_token';

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turn API validation details into a readable message for toasts/forms. */
export function formatApiError(err: unknown, fallback = 'Request failed'): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : fallback;
  }
  const details = err.details as
    | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
    | undefined;
  const fieldMsgs = details?.fieldErrors
    ? Object.entries(details.fieldErrors).flatMap(([field, msgs]) =>
        msgs.map((msg) => (field === '_errors' ? msg : `${field}: ${msg}`)),
      )
    : [];
  if (fieldMsgs.length > 0) return fieldMsgs.join(' · ');
  if (details?.formErrors?.length) return details.formErrors.join(' · ');
  return err.message || fallback;
}

export function getStoredBranchId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STORAGE_BRANCH);
}

export function setStoredBranchId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) localStorage.setItem(STORAGE_BRANCH, id);
  else localStorage.removeItem(STORAGE_BRANCH);
}

export function hasSessionFlag(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_SESSION) === '1';
}

/** Mark cookie session active; clears any legacy token storage. */
export function markSession(): void {
  localStorage.setItem(STORAGE_SESSION, '1');
  localStorage.removeItem(LEGACY_ACCESS);
  localStorage.removeItem(LEGACY_REFRESH);
}

export function clearTokens(): void {
  localStorage.removeItem(STORAGE_SESSION);
  localStorage.removeItem(LEGACY_ACCESS);
  localStorage.removeItem(LEGACY_REFRESH);
}

/** @deprecated No-op — auth uses httpOnly cookies. Kept for call-site compatibility. */
export function setTokens(_access?: string, _refresh?: string): void {
  markSession();
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (!hasSessionFlag()) return false;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!res.ok) return false;
        markSession();
        return true;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

type RequestOptions = RequestInit & {
  branch?: boolean;
  skipAuth?: boolean;
  /** Override default 20s timeout (ms). */
  timeoutMs?: number;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    branch = false,
    skipAuth = false,
    timeoutMs = 20_000,
    headers: initHeaders,
    ...init
  } = options;

  const headers = new Headers(initHeaders);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (!skipAuth) {
    // Session is httpOnly cookie — browser sends it with credentials: 'include'.
  }

  if (branch) {
    const branchId = getStoredBranchId();
    if (branchId) headers.set('X-Branch-Id', branchId);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(
        'Request timed out. The server is slow or unreachable — try again.',
        0,
        'TIMEOUT',
      );
    }
    const hint =
      process.env.NODE_ENV === 'production' && (API_BASE === '/api' || API_BASE.startsWith('/'))
        ? ' API URL looks wrong for hosting — set NEXT_PUBLIC_API_URL to your backend (e.g. https://your-api.up.railway.app) and redeploy.'
        : ' Check your internet connection, CORS_ORIGINS on the API, and that the backend is running.';
    throw new ApiError(`Cannot reach server.${hint}`, 0, 'NETWORK_ERROR');
  }

  if (res.status === 401 && !skipAuth) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
        credentials: 'include',
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    }
  }

  if (!res.ok) {
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const hint =
        process.env.NODE_ENV !== 'production'
          ? ' Local API is not responding — start the Express backend on port 3001 and check backend/.env.'
          : ' On Vercel, set NEXT_PUBLIC_API_URL to your Railway backend URL — not /api.';
      throw new ApiError(
        `API returned ${res.status} (not JSON).${hint}`,
        res.status,
        'BAD_API_RESPONSE',
      );
    }
    const err = (await res.json().catch(() => ({ message: res.statusText }))) as ApiErrorBody;
    // Hard-block clears the session: revoke, missing tenant, deactivated user, or ended period.
    const blockedCodes = new Set([
      'TENANT_ACCESS_REVOKED',
      'TENANT_NOT_FOUND',
      'USER_DEACTIVATED',
      'TENANT_TRIAL_EXPIRED',
      'TENANT_SUBSCRIPTION_EXPIRED',
    ]);
    if ((res.status === 403 || res.status === 401) && err.code && blockedCodes.has(err.code)) {
      clearTokens();
    }
    throw new ApiError(err.message ?? 'Request failed', res.status, err.code, err.details);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        skipAuth: true,
      }).then((data) => {
        markSession();
        return data;
      }),
    logout: () =>
      apiRequest<{ success: boolean }>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
        skipAuth: true,
      }),
    me: () => apiRequest<AuthUser>('/auth/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiRequest<LoginResponse>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }).then((data) => {
        markSession();
        return data;
      }),
  },

  reports: {
    dashboard: (branchId?: string, from?: string, to?: string) => {
      const params = new URLSearchParams();
      if (branchId) params.set('branchId', branchId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const q = params.toString();
      return apiRequest<DashboardSummary>(`/reports/dashboard${q ? `?${q}` : ''}`);
    },
    dailySales: (date?: string, branchId?: string) => {
      const params = new URLSearchParams();
      if (date) params.set('date', date);
      if (branchId) params.set('branchId', branchId);
      const q = params.toString();
      return apiRequest<DailySalesReport>(`/reports/daily-sales${q ? `?${q}` : ''}`);
    },
    udhaarAging: () => apiRequest<UdhaarAgingRow[]>('/reports/udhaar-aging'),
    salesSummary: (from?: string, to?: string, branchId?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (branchId) params.set('branchId', branchId);
      const q = params.toString();
      return apiRequest<SalesSummaryReport>(`/reports/sales-summary${q ? `?${q}` : ''}`);
    },
    shopPartsSummary: (from?: string, to?: string, branchId?: string, partId?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (branchId) params.set('branchId', branchId);
      if (partId) params.set('partId', partId);
      const q = params.toString();
      return apiRequest<ShopPartsSummaryReport>(`/reports/shop-parts-summary${q ? `?${q}` : ''}`);
    },
    salesTrend: (days = 14, branchId?: string) => {
      const params = new URLSearchParams({ days: String(days) });
      if (branchId) params.set('branchId', branchId);
      return apiRequest<import('@/types/api').SalesTrendReport>(`/reports/sales-trend?${params}`);
    },
    stockMovement: (from?: string, to?: string, limit?: number) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (limit != null) params.set('limit', String(limit));
      const q = params.toString();
      return apiRequest<import('@/types/api').StockMovementReport>(
        `/reports/stock-movement${q ? `?${q}` : ''}`,
      );
    },
    staffPerformance: (from?: string, to?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const q = params.toString();
      return apiRequest<import('@/types/api').StaffPerformanceRow[]>(
        `/reports/staff-performance${q ? `?${q}` : ''}`,
      );
    },
  },

  products: {
    list: (opts?: {
      search?: string;
      categoryId?: string;
      partId?: string;
      brandId?: string;
      stockStatus?: string;
      page?: number;
      pageSize?: number;
      activeOnly?: boolean;
      skipCount?: boolean;
      ids?: string[];
    }) => {
      const params = new URLSearchParams({
        page: String(opts?.page ?? 1),
        pageSize: String(opts?.pageSize ?? 50),
      });
      if (opts?.search) params.set('search', opts.search);
      if (opts?.categoryId) params.set('categoryId', opts.categoryId);
      if (opts?.partId) params.set('partId', opts.partId);
      if (opts?.brandId) params.set('brandId', opts.brandId);
      if (opts?.stockStatus) params.set('stockStatus', opts.stockStatus);
      if (opts?.activeOnly) params.set('activeOnly', 'true');
      if (opts?.skipCount) params.set('skipCount', 'true');
      if (opts?.ids?.length) params.set('ids', opts.ids.join(','));
      return apiRequest<Paginated<Product>>(`/products?${params}`);
    },
    summary: () => apiRequest<InventorySummary>('/products/summary'),
    batchStockCounts: () =>
      apiRequest<Record<string, { warehouse: number; open: number; total: number }>>(
        '/products/batch-stock-counts',
      ),
    byBarcode: (barcode: string) =>
      apiRequest<Product>(`/products/barcode/${encodeURIComponent(barcode)}`),
    miscOpen: () => apiRequest<Product>('/products/misc-open'),
    create: (body: Record<string, unknown>) =>
      apiRequest<Product>('/products', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Product>(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    adjustStock: (id: string, body: Record<string, unknown>) =>
      apiRequest<Product>(`/products/${id}/stock`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listBatches: (id: string, status?: 'WAREHOUSE' | 'OPEN' | 'CLOSED' | 'DAMAGED' | 'all') => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const q = params.toString();
      return apiRequest<ProductBatch[]>(`/products/${id}/batches${q ? `?${q}` : ''}`);
    },
    receiveBatch: (
      id: string,
      body: {
        purchaseDate: string;
        supplier?: string | null;
        purchaseReference?: string | null;
        costPerUnit?: number;
        purchaseCostPerBatch?: number;
        totalPurchaseCost?: number;
        batchCount?: number;
        quantityPerBatch?: number;
        /** @deprecated use quantityPerBatch */
        initialQuantity?: number;
        notes?: string | null;
      },
    ) =>
      apiRequest<{
        batch: ProductBatch;
        batches: ProductBatch[];
        batchCount: number;
        quantityPerBatch: string;
        totalQuantity: string;
        stockQuantity: string;
      }>(`/products/${id}/batches`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    adjustBatch: (
      batchId: string,
      body: { remainingQuantity: number; reason: string; markDamaged?: boolean },
    ) =>
      apiRequest<{
        batch: ProductBatch;
        quantityDelta: string;
        stockQuantity: string;
      }>(`/batches/${batchId}/adjust`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    closeOutBatch: (batchId: string, body: { reason: string }) =>
      apiRequest<{
        batch: ProductBatch;
        gasLossQuantity: string;
        gasLossCost: string;
        stockQuantity: string;
        summary: BatchSummary;
      }>(`/batches/${batchId}/close-out`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    openBatchForLoose: (batchId: string) =>
      apiRequest<{ batch: ProductBatch }>(`/batches/${batchId}/open-for-loose`, {
        method: 'POST',
      }),
    batchSummary: (batchId: string) =>
      apiRequest<BatchSummary>(`/batches/${batchId}/summary`),
    listOpenBatches: (productId?: string) => {
      const params = new URLSearchParams();
      if (productId) params.set('productId', productId);
      const q = params.toString();
      return apiRequest<ProductBatch[]>(`/batches${q ? `?${q}` : ''}`);
    },
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/products/${id}`, { method: 'DELETE' }),
    importCsv: (body: {
      rows: Array<{
        name: string;
        sellPrice: number;
        costPrice?: number | null;
        sku?: string | null;
        barcode?: string | null;
        unit?: string;
        categoryName?: string | null;
        brandName?: string | null;
        supplierName?: string | null;
        stockQuantity?: number;
        lowStockThreshold?: number | null;
        trackStock?: boolean;
        expiryDate?: string | null;
      }>;
      updateExisting?: boolean;
    }) =>
      apiRequest<{
        created: number;
        updated: number;
        skipped: number;
        errors: Array<{ row: number; message: string }>;
        total: number;
      }>('/products/import', {
        method: 'POST',
        body: JSON.stringify(body),
        // Large imports need more than the default 20s.
        timeoutMs: 180_000,
      }),
    purgeAll: () => apiRequest<{ deleted: number }>('/products?confirm=true', { method: 'DELETE' }),
  },

  brands: {
    list: (search?: string) => {
      const params = new URLSearchParams();
      if (search?.trim()) params.set('search', search.trim());
      const q = params.toString();
      return apiRequest<Brand[]>(`/brands${q ? `?${q}` : ''}`);
    },
    create: (body: Record<string, unknown>) =>
      apiRequest<Brand>('/brands', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Brand>(`/brands/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) => apiRequest<{ success: boolean }>(`/brands/${id}`, { method: 'DELETE' }),
  },

  suppliers: {
    list: (search?: string) => {
      const params = new URLSearchParams();
      if (search?.trim()) params.set('search', search.trim());
      const q = params.toString();
      return apiRequest<Supplier[]>(`/suppliers${q ? `?${q}` : ''}`);
    },
    create: (body: Record<string, unknown>) =>
      apiRequest<Supplier>('/suppliers', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Supplier>(`/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/suppliers/${id}`, { method: 'DELETE' }),
    ledger: (id: string) => apiRequest<SupplierLedgerEntry[]>(`/suppliers/${id}/ledger`),
    stockIn: (id: string, body: Record<string, unknown>) =>
      apiRequest<Supplier>(`/suppliers/${id}/stock-in`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    payment: (id: string, body: Record<string, unknown>) =>
      apiRequest<Supplier>(`/suppliers/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  categories: {
    list: (search?: string) => {
      const params = new URLSearchParams();
      if (search?.trim()) params.set('search', search.trim());
      const q = params.toString();
      return apiRequest<Category[]>(`/categories${q ? `?${q}` : ''}`);
    },
    create: (body: Record<string, unknown>) =>
      apiRequest<Category>('/categories', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Category>(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/categories/${id}`, { method: 'DELETE' }),
  },

  shopParts: {
    list: (search?: string) => {
      const params = new URLSearchParams();
      if (search?.trim()) params.set('search', search.trim());
      const q = params.toString();
      return apiRequest<ShopPart[]>(`/shop-parts${q ? `?${q}` : ''}`);
    },
    create: (body: Record<string, unknown>) =>
      apiRequest<ShopPart>('/shop-parts', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<ShopPart>(`/shop-parts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/shop-parts/${id}`, { method: 'DELETE' }),
    bulkAssignProducts: (body: { productIds: string[]; partId: string | null }) =>
      apiRequest<{ updated: number; partId: string | null }>('/products/bulk-assign-part', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  sales: {
    list: (page = 1, pageSize = 20, search?: string, from?: string, to?: string) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search?.trim()) params.set('search', search.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return apiRequest<Paginated<SaleListItem>>(`/sales?${params.toString()}`);
    },
    get: (saleId: string) => apiRequest<SaleDetail>(`/sales/${saleId}`),
    create: (body: Record<string, unknown>) =>
      apiRequest<CreateSaleResponse>('/sales', {
        method: 'POST',
        body: JSON.stringify(body),
        branch: true,
      }),
    void: (saleId: string, reason: string) =>
      apiRequest<{ success: boolean }>(`/sales/${saleId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    return: (saleId: string, body: Record<string, unknown>) =>
      apiRequest<Record<string, unknown>>(`/sales/${saleId}/return`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    printSlip: (saleId: string) =>
      apiRequest<{ success: boolean; mode: 'NETWORK' }>(`/sales/${saleId}/print-slip`, {
        method: 'POST',
      }),
  },

  heldCarts: {
    list: () => apiRequest<HeldCart[]>('/held-carts'),
    save: (body: Record<string, unknown>) =>
      apiRequest<HeldCart>('/held-carts', { method: 'POST', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/held-carts/${id}`, { method: 'DELETE' }),
  },

  giftCards: {
    list: () => apiRequest<GiftCard[]>('/gift-cards'),
    create: (body: Record<string, unknown>) =>
      apiRequest<GiftCard>('/gift-cards', { method: 'POST', body: JSON.stringify(body) }),
    lookup: (code: string) =>
      apiRequest<{ id: string; code: string; balance: string }>(
        `/gift-cards/lookup/${encodeURIComponent(code)}`,
      ),
  },

  discounts: {
    list: (includeInactive = false) =>
      apiRequest<DiscountRule[]>(`/discounts${includeInactive ? '?includeInactive=true' : ''}`),
    create: (body: Record<string, unknown>) =>
      apiRequest<DiscountRule>('/discounts', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<DiscountRule>(`/discounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    usageReport: (from?: string, to?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const q = params.toString();
      return apiRequest<DiscountUsageRow[]>(`/discounts/usage-report${q ? `?${q}` : ''}`);
    },
  },

  customers: {
    list: (
      search?: string,
      page = 1,
      pageSize = 50,
      sortBy?: 'name' | 'balance',
      from?: string,
      to?: string,
    ) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (sortBy) params.set('sortBy', sortBy);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return apiRequest<Paginated<Customer>>(`/customers?${params}`);
    },
    get: (id: string) => apiRequest<Customer>(`/customers/${id}`),
    create: (body: Record<string, unknown>) =>
      apiRequest<Customer>('/customers', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Customer>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/customers/${id}`, { method: 'DELETE' }),
    ledger: (id: string) => apiRequest<LedgerEntry[]>(`/customers/${id}/ledger`),
    payment: (id: string, body: Record<string, unknown>) =>
      apiRequest<Customer>(`/customers/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    voidLedger: (customerId: string, entryId: string, reason: string) =>
      apiRequest<{ success: boolean }>(`/customers/${customerId}/ledger/${entryId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
  },

  financial: {
    entries: (from?: string, to?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      return apiRequest<FinancialEntry[]>(`/financial/entries${query ? `?${query}` : ''}`);
    },
    summary: (from?: string, to?: string) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      return apiRequest<FinancialSummary>(`/financial/summary${query ? `?${query}` : ''}`);
    },
    create: (body: Record<string, unknown>) =>
      apiRequest<FinancialEntry>('/financial/entries', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    void: (id: string, reason: string) =>
      apiRequest<FinancialEntry>(`/financial/entries/${id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
  },

  settings: {
    get: () => apiRequest<BusinessSettings>('/settings'),
    update: (body: Record<string, unknown>) =>
      apiRequest<BusinessSettings>('/settings', { method: 'PATCH', body: JSON.stringify(body) }),
    export: () => apiRequest<Record<string, unknown>>('/settings/export'),
    printerTest: () =>
      apiRequest<{ success: boolean }>('/settings/printer-test', { method: 'POST' }),
  },

  branches: {
    list: () => apiRequest<Branch[]>('/branches'),
    create: (body: Record<string, unknown>) =>
      apiRequest<Branch>('/branches', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>) =>
      apiRequest<Branch>(`/branches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  },

  users: {
    list: (page = 1, pageSize = 20) =>
      apiRequest<Paginated<TenantUser>>(`/users?page=${page}&pageSize=${pageSize}`),
    create: (body: Record<string, unknown>) =>
      apiRequest<TenantUser>('/users', { method: 'POST', body: JSON.stringify(body) }),
    update: (userId: string, body: Record<string, unknown>) =>
      apiRequest<TenantUser>(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    setFeatures: (userId: string, featureKeys: string[]) =>
      apiRequest<TenantUser>(`/users/${userId}/features`, {
        method: 'PUT',
        body: JSON.stringify({ featureKeys }),
      }),
  },

  features: {
    list: () => apiRequest<FeatureRegistryItem[]>('/features'),
  },

  sync: {
    status: () => apiRequest<SyncStatus>('/sync/status'),
    issues: () => apiRequest<{ data: SyncIssue[] }>('/sync/outbox/issues'),
    retry: (outboxId: string) =>
      apiRequest<{ id: string; status: string }>(`/sync/outbox/${outboxId}/retry`, {
        method: 'POST',
      }),
    dismiss: (outboxId: string, reason: string) =>
      apiRequest<{ id: string; status: string }>(`/sync/outbox/${outboxId}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    run: () => apiRequest<Record<string, unknown>>('/sync/run', { method: 'POST' }),
  },

  admin: {
    dashboard: () => apiRequest<AdminDashboard>('/admin/dashboard'),
    salesReps: () => apiRequest<SalesRep[]>('/admin/sales-reps'),
    createSalesRep: (body: { fullName: string }) =>
      apiRequest<SalesRep>('/admin/sales-reps', { method: 'POST', body: JSON.stringify(body) }),
  },

  support: {
    createQuery: (body: {
      topic: string;
      subject: string;
      message: string;
      contactEmail: string;
    }) =>
      apiRequest<{
        id: string;
        topic: string;
        subject: string;
        status: string;
        createdAt: string;
      }>('/support/queries', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  platform: {
    listTenants: (page = 1, pageSize = 20) =>
      apiRequest<Paginated<TenantRow>>(`/tenants?page=${page}&pageSize=${pageSize}`),
    getTenant: (id: string) => apiRequest<TenantDetail>(`/tenants/${id}`),
    createTenant: (body: Record<string, unknown>) =>
      apiRequest<TenantDetail>('/tenants', { method: 'POST', body: JSON.stringify(body) }),
    updateTenant: (id: string, body: Record<string, unknown>) =>
      apiRequest<TenantDetail>(`/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    setTenantFeatures: (id: string, featureKeys: string[]) =>
      apiRequest<TenantDetail>(`/tenants/${id}/features`, {
        method: 'PUT',
        body: JSON.stringify({ featureKeys }),
      }),
    revokeTenantAccess: (id: string, reason?: string) =>
      apiRequest<TenantDetail>(`/tenants/${id}/revoke-access`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    restoreTenantAccess: (
      id: string,
      body?: { subscriptionStartAt?: string; subscriptionDays?: number; feeStatus?: string },
    ) =>
      apiRequest<TenantDetail>(`/tenants/${id}/restore-access`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    listTenantUsers: (tenantId: string, page = 1) =>
      apiRequest<Paginated<TenantUser>>(`/tenants/${tenantId}/users?page=${page}&pageSize=50`),
    createTenantUser: (tenantId: string, body: Record<string, unknown>) =>
      apiRequest<TenantUser>(`/tenants/${tenantId}/users`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateTenantUser: (
      tenantId: string,
      userId: string,
      body: { isActive?: boolean; fullName?: string },
    ) =>
      apiRequest<TenantUser>(`/tenants/${tenantId}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteTenantUser: (tenantId: string, userId: string) =>
      apiRequest<{ success: boolean }>(`/tenants/${tenantId}/users/${userId}`, {
        method: 'DELETE',
      }),
    setTenantUserPassword: (
      tenantId: string,
      userId: string,
      body: { password: string; mustChangePassword?: boolean },
    ) =>
      apiRequest<{ success: boolean; mustChangePassword: boolean }>(
        `/tenants/${tenantId}/users/${userId}/set-password`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
  },
};
