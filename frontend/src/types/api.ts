import type { FeatureKey, UserRole } from '@/lib/shared';

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface PaginatedMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginatedMeta;
}

export interface PlanEntitlement {
  tier?: string;
  trialPlanTier?: string | null;
  assignedPlan?: string;
  trialPlan?: string;
  effectivePlan?: string;
  accessStatus?: string;
  isTrialActive?: boolean;
  isPaidActive?: boolean;
  isSoftLocked?: boolean;
  daysRemaining?: number | null;
  subscriptionStartAt?: string | null;
  subscriptionEndsAt?: string | null;
  subscriptionDays?: number;
  /** monthly when subscriptionDays < 300, yearly otherwise */
  billingCycle?: 'monthly' | 'yearly';
  upgradeUrl?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  tenantId?: string | null;
  features: FeatureKey[];
  mustChangePassword: boolean;
  planEntitlement?: PlanEntitlement | null;
}

export interface LoginResponse {
  mustChangePassword: boolean;
  user: AuthUser;
}

export interface DashboardSummary {
  todaySalesTotal: string;
  /** Gross COMPLETED sales before subtracting returns. */
  todayGrossSalesTotal?: string;
  todayTransactionCount: number;
  averageOrderValue?: string;
  revenueChangePct?: number;
  aovChangePct?: number;
  transactionChangePct?: number;
  from?: string;
  to?: string;
  chartMode?: 'hourly' | 'daily';
  compareLabel?: string;
  /** Total products below threshold (may exceed alerts list). */
  lowStockCount: number;
  /** Preview list (top 5). */
  lowStockAlerts: Array<{
    id: string;
    name: string;
    stockQuantity: string;
    lowStockThreshold: string;
  }>;
  /** Sum of cost × qty for active products. */
  inventoryValue?: string;
  /** Total active products in the catalog. */
  totalProducts?: number;
  outstandingUdhaar: string;
  todayReturnsAmount?: string;
  todayReturnsCount?: number;
  todayReturnedUnits?: string;
  hourlySales?: Array<{
    hour: string;
    revenue: number;
    transactions: number;
  }>;
  paymentMethods?: Array<{
    name: string;
    value: number;
    amount?: string;
    color: string;
  }>;
  topProducts?: Array<{
    name: string;
    revenue: number;
    quantitySold: number;
  }>;
  topCategories?: Array<{
    id: string;
    name: string;
    revenue: number;
    quantitySold: number;
  }>;
}

export interface SalesTrendPoint {
  date: string;
  /** Net sales (gross − returns) for the day. */
  sales: string;
  grossSales?: string;
  transactions: number;
  returns: string;
}

export interface SalesTrendReport {
  from: string;
  to: string;
  days: number;
  /** Net sales across the period. */
  totalSales: string;
  totalGrossSales?: string;
  totalTransactions: number;
  totalReturns: string;
  growthPct: number;
  series: SalesTrendPoint[];
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  unit: string;
  costPrice: string | null;
  sellPrice: string;
  batchSellPrice?: string | null;
  stockQuantity: string;
  /** Total active batches (warehouse + open on counter). */
  batchStockCount?: number | null;
  /** Batches received but not yet opened for loose sales. */
  batchWarehouseCount?: number | null;
  /** Batches open on the counter for loose sales. */
  batchOpenCount?: number | null;
  lowStockThreshold: string | null;
  targetStock: string | null;
  /** Current cost × target stock. Null when a target is set but the cost is unknown. */
  targetStockAmount?: string | null;
  taxRate: string;
  expiryDate: string | null;
  trackStock: boolean;
  trackType?: 'SIMPLE' | 'BATCH';
  dispensingLossPercent?: string;
  isActive: boolean;
  category: { id: string; name: string } | null;
  part: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
}

export interface ProductBatch {
  id: string;
  productId: string;
  purchaseDate: string;
  supplier: string | null;
  purchaseReference: string | null;
  costPerUnit: string;
  initialQuantity: string;
  remainingQuantity: string;
  status: 'WAREHOUSE' | 'OPEN' | 'CLOSED' | 'DAMAGED';
  notes: string | null;
  closedAt: string | null;
  gasLossQuantity: string | null;
  gasLossCost: string | null;
  createdAt: string;
  updatedAt: string;
  product?: { id: string; name: string; unit: string };
}

export interface BatchSummary {
  batchId: string;
  status: 'WAREHOUSE' | 'OPEN' | 'CLOSED' | 'DAMAGED';
  unit: string;
  productName: string;
  purchaseCost: string;
  revenue: string;
  cogsSold: string;
  gasLossQuantity: string;
  gasLossCost: string;
  netProfit: string;
  saleCount: number;
  avgLossPerCharge: string | null;
  effectiveLossPercent: string;
  isFinal: boolean;
  remainingQuantity: string;
  initialQuantity: string;
  costPerUnit: string;
  closedAt: string | null;
}

export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  balance: string;
  isActive: boolean;
}

export interface SupplierLedgerEntry {
  id: string;
  entryType: string;
  amount: string;
  balanceAfter: string;
  paymentMethod: string | null;
  notes: string | null;
  referenceType: string | null;
  referenceId: string | null;
  recordedBy: { id: string; fullName: string } | null;
  createdAt: string;
  description: string;
  stockIn: {
    productId: string;
    productName: string;
    sku: string | null;
    unit: string;
    quantity: string;
    notes: string | null;
  } | null;
}

export interface InventorySummary {
  totalProducts: number;
  healthyCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  inventoryValue: string;
  projectedProfit: string;
  /** Sum of current cost × target stock across products. */
  targetStockAmount: string;
  /** Products with a target set but no known cost; left out of targetStockAmount. */
  targetStockMissingCostCount: number;
}

export interface HeldCart {
  id: string;
  name: string | null;
  cartData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GiftCard {
  id: string;
  code: string;
  initialBalance: string;
  balance: string;
  isActive: boolean;
  expiresAt: string | null;
}

export interface SaleDetail {
  id: string;
  saleNumber: string;
  status: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  amountReceived: string | null;
  changeGiven: string | null;
  paymentStatus: string;
  notes: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  fbrInvoiceNumber: string | null;
  fbrQrData: string | null;
  customer: { id: string; name: string; phone: string | null } | null;
  cashier: { id: string; fullName: string };
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    unitPrice: string;
    quantity: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
    returnedQuantity?: string;
    returnableQuantity?: string;
  }>;
  payments: Array<{ id: string; paymentMethod: string; amount: string }>;
  returns: Array<{
    id: string;
    returnNumber: string;
    reason: string;
    totalAmount: string;
    createdAt: string;
    items: Array<{
      id: string;
      saleItemId: string;
      productName: string;
      quantity: string;
      refundAmount: string;
    }>;
  }>;
  receipt: {
    businessName: string;
    address: string | null;
    phone: string | null;
    logoUrl?: string | null;
    receiptHeaderMode?: 'NAME' | 'LOGO' | 'BOTH';
    taxLabel: string;
    receiptFooter: string | null;
    currency: string;
    fbrEnabled: boolean;
    fbrPosId: string | null;
    fbrStrn: string | null;
    fbrRegisteredName: string | null;
    builtBy: string;
  };
}

export interface SalesSummaryReport {
  from: string;
  to: string;
  transactionCount: number;
  returnsCount?: number;
  grossRevenue?: string;
  returnsAmount?: string;
  /** Net revenue after returns. */
  revenue: string;
  cost: string;
  grossProfit: string;
  taxTotal: string;
  discountTotal: string;
  averageTicket: string;
  topProducts: Array<{
    productId: string;
    name: string;
    quantitySold: number;
    revenue: string;
  }>;
}

export interface StockMovementReport {
  movements: Array<{
    id: string;
    productName: string;
    movementType: string;
    quantityDelta: string;
    createdAt: string;
  }>;
  /** @deprecated Prefer Inventory page stock filters (`?stock=low`). */
  lowStockAlerts?: Array<{
    id: string;
    name: string;
    stockQuantity: string;
    lowStockThreshold: string;
  }>;
}

export interface StaffPerformanceRow {
  cashierId: string;
  cashierName: string;
  transactionCount: number;
  totalSales: string;
}

export interface DiscountUsageRow {
  discountRuleId: string;
  ruleName: string;
  usageCount: number;
  totalDiscount: string;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ShopPart {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ShopPartSummaryRow {
  partId: string | null;
  name: string;
  revenue: string;
  cost: string;
  grossProfit: string;
  taxTotal: string;
  purchaseTotal: string;
  transactionCount: number;
}

export interface ShopPartsSummaryReport {
  from: string;
  to: string;
  combined: ShopPartSummaryRow;
  parts: ShopPartSummaryRow[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  creditLimit: string | null;
  balance: string;
  notes: string | null;
  isActive: boolean;
}

export interface FinancialEntry {
  id: string;
  entryType: string;
  amount: string;
  category: string;
  description: string | null;
  occurredAt: string;
  recordedById: string;
  voidedAt: string | null;
  voidReason: string | null;
  flow?: 'in' | 'out' | 'stock' | 'other';
}

export interface FinancialSummary {
  from: string | null;
  to: string | null;
  inflows: string;
  outflows: string;
  netMovement: string;
  moneyIn?: string;
  moneyOut?: string;
  cashLeft?: string;
  manualInflows: string;
  manualOutflows: string;
  salesCollected: string;
  customerCollections: string;
  supplierPayments: string;
  purchasesRecorded: string;
  stockBought?: string;
  stillOweSuppliers?: string;
  ownerPutIn?: string;
  otherIncome?: string;
  shopExpenses?: string;
  ownerTookOut?: string;
  refunds?: string;
  cashStockPurchases?: string;
  byType: Record<string, string>;
}

export interface LedgerEntry {
  id: string;
  entryType: string;
  amount: string;
  balanceAfter: string;
  paymentMethod: string | null;
  notes: string | null;
  voidedAt: string | null;
  recordedBy: { id: string; fullName: string } | null;
  createdAt: string;
  saleId: string | null;
  saleNumber: string | null;
  saleTotal: string | null;
  dueDate: string | null;
  daysOutstanding: number | null;
  remainingAmount: string | null;
  description: string;
}

export interface SaleListItem {
  id: string;
  saleNumber: string;
  status?: string;
  subtotal?: string;
  discountTotal?: string;
  taxTotal?: string;
  grandTotal: string;
  paymentStatus: string;
  createdAt: string;
  customer: { id: string; name: string; phone?: string | null } | null;
  cashier?: { id: string; fullName: string };
  itemCount?: number;
  payments?: Array<{ paymentMethod: string; amount: string }>;
  hasReturns?: boolean;
  returnedTotal?: string;
  netTotal?: string;
}

export interface CreateSaleResponse {
  sale: {
    id: string;
    saleNumber: string;
    grandTotal: string;
    paymentStatus: string;
    createdAt: string;
  };
  /** Full receipt payload — avoids a second GET after checkout. */
  detail?: SaleDetail;
  printReceipt: boolean;
  creditLimitWarning?: string;
}

export interface DiscountRule {
  id: string;
  name: string;
  discountType: string;
  value: string;
  appliesTo: string;
  productId: string | null;
  categoryId: string | null;
  minBillAmount: string | null;
  isActive: boolean;
  usageCount?: number;
  totalDiscountGiven?: string;
}

export interface BusinessSettings {
  tenantId: string;
  businessName: string;
  address: string | null;
  phone: string | null;
  logoUrl: string | null;
  currency: string;
  taxLabel: string;
  defaultTaxRate: string;
  printReceiptsDefault: boolean;
  /** Open on-screen receipt after a completed sale (shop default). */
  showReceiptAfterSale: boolean;
  receiptFooter: string | null;
  receiptHeaderMode: 'NAME' | 'LOGO' | 'BOTH';
  maxDiscountPercentStaff: string | null;
  fbrEnabled: boolean;
  fbrPosId: string | null;
  fbrStrn: string | null;
  fbrRegisteredName: string | null;
  printerMode: 'BROWSER' | 'NETWORK';
  printerHost: string | null;
  printerPort: number;
  printerPaperWidth: 58 | 80;
  saleQuickPickIds: string[];
  dashboardLayout: DashboardLayout | null;
}

export type DashboardWidgetId =
  'kpis' | 'trend' | 'payments' | 'topProducts' | 'topCategories' | 'returns' | 'lowStock';

export interface DashboardLayoutWidget {
  id: DashboardWidgetId;
  visible: boolean;
}

export interface DashboardLayout {
  widgets: DashboardLayoutWidget[];
}

export interface Branch {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface TenantUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  features: string[];
  branchId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface DailySalesReport {
  date: string;
  total: string;
  transactionCount: number;
  sales: Array<{
    id: string;
    saleNumber: string;
    grandTotal: string;
    paymentStatus: string;
    customerName: string | null;
    createdAt: string;
  }>;
}

export interface UdhaarAgingRow {
  customerId: string;
  name: string;
  phone: string | null;
  bucket0_7: string;
  bucket8_30: string;
  bucket30_plus: string;
  total: string;
}

export interface SyncStatus {
  deploymentMode: string;
  pendingChanges: number;
  conflictChanges: number;
  failedChanges: number;
  status: 'synced' | 'pending' | 'conflict' | 'failed';
  userMessage: string | null;
  workerRunning: boolean;
  workerConfigured: boolean;
  lastPushedAt: string | null;
  lastPulledAt: string | null;
  cloudCursor: string | null;
}

export interface SyncIssue {
  id: string;
  tableName: string;
  recordId: string;
  operation: string;
  status: string;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  syncedAt: string | null;
}

export interface FeatureRegistryItem {
  key: string;
  module: string;
  label: string;
  description: string | null;
}

export interface AdminDashboard {
  totals: {
    tenants: number;
    activeTenants: number;
    inactiveTenants: number;
    clientUsers: number;
    activeClientUsers: number;
    salesReps: number;
  };
  feeStatus: { status: string; count: number }[];
  salesRepPerformance: { salesRepId: string | null; salesRepName: string; clientCount: number }[];
  recentTenants: {
    id: string;
    name: string;
    slug: string;
    tier: string;
    isActive: boolean;
    feeStatus: string;
    monthlyFee: string | null;
    userCount: number;
    acquiredBy: { id: string; name: string } | null;
    createdAt: string;
  }[];
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  tier: string;
  isActive: boolean;
  featureCount: number;
  userCount: number;
  feeStatus: string;
  monthlyFee: string | null;
  feeDueDate: string | null;
  acquiredBy: { id: string; name: string } | null;
  createdAt: string;
  subscriptionStartAt: string | null;
  subscriptionEndsAt: string | null;
  subscriptionDays: number;
  accessRevokedAt: string | null;
  accessRevokeReason: string | null;
  daysRemaining: number | null;
  subscriptionExpired: boolean;
  accessStatus: string;
  isTrial?: boolean;
  billingCycle?: 'monthly' | 'yearly';
}

export interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  tier: string;
  trialPlanTier?: string | null;
  isTrial?: boolean;
  billingCycle?: 'monthly' | 'yearly';
  isActive: boolean;
  feeStatus: string;
  monthlyFee: string | null;
  feeDueDate: string | null;
  acquiredBy: { id: string; name: string; email?: string } | null;
  createdAt: string;
  updatedAt?: string;
  features: string[];
  planFeatureKeys?: string[];
  featureOverrides?: string[];
  subscriptionStartAt: string | null;
  subscriptionEndsAt: string | null;
  subscriptionDays: number;
  accessRevokedAt: string | null;
  accessRevokeReason: string | null;
  daysRemaining: number | null;
  subscriptionExpired: boolean;
  isTrialActive?: boolean;
  isPaidActive?: boolean;
  isSoftLocked?: boolean;
  effectivePlan?: string;
  assignedPlan?: string;
  trialPlan?: string;
  accessStatus: string;
}

export interface SalesRep {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  clientCount: number;
  createdAt: string;
}
