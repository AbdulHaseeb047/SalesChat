import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from '@/lib/next-nav';

import { ReceiptView } from '@/components/billing/ReceiptView';
import { IconSearch, IconWallet } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import {
  isExchangeSaleLocationState,
  type ExchangeSaleLocationState,
} from '@/features/billing/exchange-handoff';
import { ApiError, api } from '@/lib/api-client';
import { prefersDesktopInput, safeFocus } from '@/lib/device';
import { FEATURES, hasFeature } from '@/lib/features';
import { useAuth } from '@/lib/auth';
import { formatMoney, formatQty } from '@/lib/format';
import { printSaleReceipt } from '@/lib/print-receipt';
import { resolveReceiptAfterSale } from '@/lib/receipt-prefs';
import { calcSaleTotals, canAddToCart, formatSaleStockBadge, getStockStatus, isBatchProduct, needsBatchSaleModal, looseUnitPrice, wholeBatchPrice, billedQuantity, amountFromQty, qtyFromAmount, roundSoldQty, type BatchSaleMode } from '@/lib/sale-utils';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { productMatchesSearch, customerMatchesSearch } from '@/lib/search-match';
import type { Customer, HeldCart, Product, ProductBatch, SaleDetail } from '@/types/api';
import { QuickPickCustomizeModal } from '@/features/billing/QuickPickCustomizeModal';

const SALE_SEARCH_LIMIT = 40;

interface CartLine {
  /** Unique key so multiple misc/open lines can coexist. */
  key: string;
  product: Product;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  /** Receipt label override for open/misc amounts. */
  customName?: string;
  /** Selected batch for BATCH products. */
  batchId?: string;
  batchLabel?: string;
  saleMode?: BatchSaleMode;
  /** Stock qty removed on whole-batch sale (all meters/kg on the batch). */
  batchStockDeduct?: number;
}

type PaymentMode = 'CASH' | 'CREDIT' | 'SPLIT';

function roundUpToStep(amount: number, step: number): number {
  if (amount <= 0) return step;
  return Math.ceil(amount / step) * step;
}

function summarizeHeldCart(data: Record<string, unknown>) {
  const cart = (data.cart as CartLine[] | undefined) ?? [];
  const customer = data.customer as Customer | undefined;
  const billDiscount = Number(data.billDiscount) || 0;
  const heldTotal = Number(data.heldTotal);
  const lineCount = cart.length;
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const computedSubtotal = cart.reduce(
    (sum, line) => sum + line.quantity * line.unitPrice - line.discountAmount,
    0,
  );
  return {
    customerName: customer?.name ?? 'Walk-in',
    lineCount,
    itemCount,
    total: Number.isFinite(heldTotal) ? heldTotal : Math.max(0, computedSubtotal - billDiscount),
  };
}

export function SalePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exchangeAppliedRef = useRef(false);

  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('CASH');
  const [cashAmount, setCashAmount] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [amountReceived, setAmountReceived] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [billDiscount, setBillDiscount] = useState(0);
  const [discountInput, setDiscountInput] = useState('');
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [appliedDiscounts, setAppliedDiscounts] = useState<
    Array<{ ruleId: string; amount: number }>
  >([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [receiptSale, setReceiptSale] = useState<SaleDetail | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [holdLabel, setHoldLabel] = useState('');
  const [holdMessage, setHoldMessage] = useState('');
  const [showCheckout, setShowCheckout] = useState(false);
  const [saleSuccessFlash, setSaleSuccessFlash] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [deleteHeldTarget, setDeleteHeldTarget] = useState<HeldCart | null>(null);
  const [exchangeBanner, setExchangeBanner] = useState<ExchangeSaleLocationState | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [batchEntryProduct, setBatchEntryProduct] = useState<Product | null>(null);
  const [batchEntryEditKey, setBatchEntryEditKey] = useState<string | null>(null);
  const [batchOptions, setBatchOptions] = useState<ProductBatch[]>([]);
  const [batchOptionsLoading, setBatchOptionsLoading] = useState(false);
  const [batchForm, setBatchForm] = useState({
    saleMode: 'LOOSE' as BatchSaleMode,
    batchId: '',
    qty: '',
    amount: '',
  });
  const [allowSplitBatches, setAllowSplitBatches] = useState(false);
  const [splitConfirmOpen, setSplitConfirmOpen] = useState(false);
  const [splitConfirmMessage, setSplitConfirmMessage] = useState('');
  const pendingSaleBodyRef = useRef<Record<string, unknown> | null>(null);

  const canDiscount = hasFeature(user, FEATURES.BILLING_DISCOUNT);
  const canDiscountUnlimited = hasFeature(user, FEATURES.BILLING_DISCOUNT_UNLIMITED);
  const canPrint = hasFeature(user, FEATURES.BILLING_PRINT_RECEIPT);
  const canCustomize = hasFeature(user, FEATURES.UI_CUSTOMIZE);
  const canUseProductImages = hasFeature(user, FEATURES.INVENTORY_PRODUCT_IMAGES);
  const [showQuickPickCustomize, setShowQuickPickCustomize] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });
  const quickPickIds = settings?.saleQuickPickIds ?? [];
  const useCustomQuickPick =
    canCustomize && quickPickIds.length > 0 && !categoryId && !search.trim();
  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.categories.list(),
  });
  const { data: discountRules } = useQuery({
    queryKey: ['discounts', 'active'],
    queryFn: () => api.discounts.list(false),
    enabled: canDiscount,
  });
  const debouncedCustomerSearch = useDebouncedValue(customerSearch, 300);
  const debouncedSearch = useDebouncedValue(search, 150);

  const {
    data: searchPage,
    isLoading: searchLoading,
    isFetching: searchFetching,
  } = useQuery({
    // "All" (no category) still loads a browse set so cashiers see products immediately.
    queryKey: ['products', 'sale-browse', debouncedSearch, categoryId || 'all'],
    queryFn: () =>
      api.products.list({
        search: debouncedSearch.trim() || undefined,
        categoryId: categoryId || undefined,
        page: 1,
        pageSize: SALE_SEARCH_LIMIT,
        activeOnly: true,
        skipCount: true,
      }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const {
    data: quickPickPage,
    isLoading: quickPickLoading,
    isFetching: quickPickFetching,
  } = useQuery({
    queryKey: ['products', 'sale-quick-pick', quickPickIds],
    queryFn: () =>
      api.products.list({
        ids: quickPickIds,
        activeOnly: true,
        pageSize: SALE_SEARCH_LIMIT,
      }),
    staleTime: 30_000,
    enabled: canCustomize && quickPickIds.length > 0,
  });
  const { data: customers, isFetching: customersFetching } = useQuery({
    queryKey: ['customers', 'sale', debouncedCustomerSearch],
    queryFn: () => api.customers.list(debouncedCustomerSearch || undefined, 1, 15),
    enabled: debouncedCustomerSearch.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
  const canHoldBills = hasFeature(user, FEATURES.BILLING_HELD_CARTS);
  const { data: heldCarts, refetch: refetchHeld } = useQuery({
    queryKey: ['held-carts'],
    queryFn: () => api.heldCarts.list(),
    staleTime: 60_000,
    enabled: canHoldBills,
  });

  const defaultTax = parseFloat(settings?.defaultTaxRate ?? '0');
  const currency = settings?.currency ?? 'PKR';
  const maxDiscountPercent = settings?.maxDiscountPercentStaff
    ? parseFloat(settings.maxDiscountPercentStaff)
    : null;

  useEffect(() => {
    if (exchangeAppliedRef.current) return;
    if (!isExchangeSaleLocationState(location.state)) return;
    exchangeAppliedRef.current = true;
    const state = location.state;
    setExchangeBanner(state);
    setNotes(`Exchange from ${state.exchangeFromSaleNumber}`);
    if (state.customerName) {
      setCustomerSearch(state.customerName);
    }
    if (state.customerId) {
      void api.customers
        .get(state.customerId)
        .then((c) => {
          setCustomer(c);
          setCustomerSearch(c.name);
        })
        .catch(() => {
          /* keep name-only hint if fetch fails */
        });
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  const totals = useMemo(
    () => calcSaleTotals(cart, billDiscount, defaultTax),
    [cart, billDiscount, defaultTax],
  );

  const exchangeCredit = useMemo(() => {
    if (!exchangeBanner) return 0;
    const n = parseFloat(exchangeBanner.creditHint);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  }, [exchangeBanner]);

  const exchangeApplied = useMemo(
    () => Math.min(exchangeCredit, Math.round(totals.grandTotal * 100) / 100),
    [exchangeCredit, totals.grandTotal],
  );

  const exchangeRemaining = useMemo(
    () => Math.max(0, Math.round((exchangeCredit - totals.grandTotal) * 100) / 100),
    [exchangeCredit, totals.grandTotal],
  );

  const payableAfterExchange = useMemo(
    () => Math.max(0, Math.round((totals.grandTotal - exchangeCredit) * 100) / 100),
    [totals.grandTotal, exchangeCredit],
  );

  const creditLimitWarning = useMemo(() => {
    if (!customer?.creditLimit || paymentMode === 'CASH') return null;
    const limit = parseFloat(customer.creditLimit);
    const balance = parseFloat(customer.balance);
    const creditPart =
      paymentMode === 'CREDIT'
        ? totals.grandTotal
        : paymentMode === 'SPLIT'
          ? parseFloat(creditAmount) || 0
          : 0;
    if (creditPart <= 0) return null;
    if (balance + creditPart > limit) {
      return `Udhaar limit cross: ${formatMoney(balance + creditPart, currency)} / ${formatMoney(limit, currency)}`;
    }
    return null;
  }, [customer, paymentMode, totals.grandTotal, creditAmount, currency]);

  const loadBatchOptions = useCallback(
    async (product: Product, saleMode: BatchSaleMode) => {
      setBatchOptionsLoading(true);
      try {
        const status = saleMode === 'WHOLE' ? 'WAREHOUSE' : 'OPEN';
        const rows = await api.products.listBatches(product.id, status);
        setBatchOptions(rows);
        return rows;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load batches');
        setBatchOptions([]);
        return [];
      } finally {
        setBatchOptionsLoading(false);
      }
    },
    [toast],
  );

  const openBatchEntry = useCallback(
    async (product: Product, existing?: CartLine) => {
      const saleMode = existing?.saleMode ?? 'LOOSE';
      setBatchEntryProduct(product);
      setBatchEntryEditKey(existing?.key ?? null);
      const price =
        saleMode === 'WHOLE' ? wholeBatchPrice(product) : looseUnitPrice(product);
      const qty = existing?.quantity ?? 0;
      setBatchForm({
        saleMode,
        batchId: existing?.batchId ?? '',
        qty: saleMode === 'WHOLE' ? '1' : qty > 0 ? String(qty) : '',
        amount:
          saleMode === 'WHOLE'
            ? String(price)
            : qty > 0
              ? String(amountFromQty(qty, price))
              : '',
      });
      const rows = await loadBatchOptions(product, saleMode);
      if (!existing?.batchId && rows.length > 0) {
        const first = rows[0]!;
        if (saleMode === 'WHOLE') {
          setBatchForm((prev) => ({
            ...prev,
            batchId: first.id,
            qty: '1',
            amount: String(price),
          }));
        } else {
          setBatchForm((prev) => ({ ...prev, batchId: first.id }));
        }
      }
    },
    [loadBatchOptions],
  );

  const addToCart = useCallback(
    (
      product: Product,
      opts?: {
        quantity?: number;
        unitPrice?: number;
        customName?: string;
        batchId?: string;
        batchLabel?: string;
        saleMode?: BatchSaleMode;
        batchStockDeduct?: number;
        skipBatchModal?: boolean;
      },
    ) => {
      if (needsBatchSaleModal(product) && !opts?.skipBatchModal && !opts?.customName) {
        void openBatchEntry(product);
        return;
      }

      const qty = opts?.quantity ?? 1;
      const unitPrice = opts?.unitPrice ?? parseFloat(product.sellPrice);
      const customName = opts?.customName?.trim();
      const existing = cart.find(
        (l) =>
          l.product.id === product.id &&
          (l.customName ?? '') === (customName ?? '') &&
          l.unitPrice === unitPrice &&
          (l.batchId ?? '') === (opts?.batchId ?? '') &&
          (l.saleMode ?? 'LOOSE') === (opts?.saleMode ?? 'LOOSE') &&
          !customName,
      );
      const currentQty = existing?.quantity ?? 0;
      if (isBatchProduct(product) && opts?.skipBatchModal) {
        if (!canAddToCart(product, qty, 0)) {
          setError(`${product.name} is out of stock`);
          return;
        }
      } else if (!needsBatchSaleModal(product) && !canAddToCart(product, qty, currentQty)) {
        setError(`${product.name} is out of stock`);
        return;
      }
      setError('');
      setCart((prev) => {
        // Misc/open lines always add as their own row (or merge same description+price)
        if (customName) {
          const ex = prev.find(
            (l) =>
              l.product.id === product.id &&
              (l.customName ?? '') === customName &&
              l.unitPrice === unitPrice,
          );
          if (ex) {
            return prev.map((l) => (l.key === ex.key ? { ...l, quantity: l.quantity + qty } : l));
          }
          return [
            ...prev,
            {
              key: `misc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              product,
              quantity: qty,
              unitPrice,
              discountAmount: 0,
              customName,
            },
          ];
        }
        if (needsBatchSaleModal(product)) {
          const saleMode = opts?.saleMode ?? 'LOOSE';
          const soldQty = billedQuantity(saleMode, qty);
          return [
            ...prev,
            {
              key: `batch-${product.id}-${opts?.batchId ?? 'none'}-${saleMode}-${Date.now()}`,
              product,
              quantity: soldQty,
              unitPrice,
              discountAmount: 0,
              batchId: opts?.batchId,
              batchLabel: opts?.batchLabel,
              saleMode,
              batchStockDeduct: opts?.batchStockDeduct,
            },
          ];
        }
        const ex = prev.find((l) => l.product.id === product.id && !l.customName && !l.batchId);
        if (ex) {
          return prev.map((l) => (l.key === ex.key ? { ...l, quantity: l.quantity + qty } : l));
        }
        return [
          ...prev,
          {
            key: product.id,
            product,
            quantity: qty,
            unitPrice,
            discountAmount: 0,
          },
        ];
      });
      const nextItemCount = existing ? cart.length : cart.length + 1;
      toast.info(`Added · ${nextItemCount} item${nextItemCount === 1 ? '' : 's'}`);
      setSearch('');
      setShowDropdown(false);
      safeFocus(searchRef.current);
    },
    [cart, toast, openBatchEntry],
  );

  const commitBatchEntry = () => {
    if (!batchEntryProduct) return;
    const saleMode = batchForm.saleMode;
    const selectedBatch = batchOptions.find((b) => b.id === batchForm.batchId);
    const price =
      saleMode === 'WHOLE'
        ? wholeBatchPrice(batchEntryProduct)
        : looseUnitPrice(batchEntryProduct);
    const stockDeduct =
      saleMode === 'WHOLE' && selectedBatch
        ? parseFloat(selectedBatch.remainingQuantity)
        : undefined;
    const qty =
      saleMode === 'WHOLE'
        ? 1
        : roundSoldQty(parseFloat(batchForm.qty));
    if (!Number.isFinite(price) || price < 0) {
      setError('Invalid price');
      return;
    }
    if (saleMode === 'WHOLE') {
      if (!selectedBatch || stockDeduct! <= 0) {
        setError('Select a warehouse batch with stock');
        return;
      }
    } else if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter quantity or amount');
      return;
    }
    if (batchOptions.length > 0 && !batchForm.batchId) {
      setError('Select a batch to draw from');
      return;
    }
    if (
      saleMode === 'LOOSE' &&
      selectedBatch &&
      qty > parseFloat(selectedBatch.remainingQuantity) + 0.0001 &&
      batchOptions.length === 1
    ) {
      setError(
        `Not enough in this batch (need ${formatQty(qty)} ${batchEntryProduct.unit}, have ${formatQty(selectedBatch.remainingQuantity)})`,
      );
      return;
    }
    if (saleMode === 'LOOSE' && !batchEntryEditKey) {
      const totalOpen = batchOptions.reduce((s, b) => s + parseFloat(b.remainingQuantity), 0);
      if (qty > totalOpen + 0.0001) {
        setError(
          `Not enough open counter stock (need ${formatQty(qty)} ${batchEntryProduct.unit}, have ${formatQty(totalOpen)})`,
        );
        return;
      }
    }

    const batchLabel = selectedBatch
      ? saleMode === 'WHOLE'
        ? `Whole batch · ${formatQty(selectedBatch.remainingQuantity)} ${batchEntryProduct.unit} · ${formatMoney(price, currency)}`
        : `${formatQty(selectedBatch.remainingQuantity)} ${batchEntryProduct.unit} left · ${selectedBatch.purchaseDate}`
      : undefined;

    if (batchEntryEditKey) {
      setCart((prev) =>
        prev.map((l) =>
          l.key === batchEntryEditKey
            ? {
                ...l,
                quantity: qty,
                unitPrice: price,
                batchId: batchForm.batchId || undefined,
                batchLabel,
                saleMode,
                batchStockDeduct: stockDeduct,
              }
            : l,
        ),
      );
    } else {
      addToCart(batchEntryProduct, {
        quantity: qty,
        unitPrice: price,
        batchId: batchForm.batchId || undefined,
        batchLabel,
        saleMode,
        batchStockDeduct: stockDeduct,
        skipBatchModal: true,
      });
    }
    setBatchEntryProduct(null);
    setBatchEntryEditKey(null);
    setError('');
  };

  const applyDiscountRule = useCallback(
    (ruleId: string) => {
      const rule = discountRules?.find((r) => r.id === ruleId);
      if (!rule) return;
      setSelectedRuleId(ruleId);

      if (rule.appliesTo === 'BILL') {
        const min = rule.minBillAmount ? parseFloat(rule.minBillAmount) : 0;
        if (totals.subtotal < min) {
          setError(`Minimum bill ${formatMoney(min, currency)} required for this rule`);
          return;
        }
        const val = parseFloat(rule.value);
        const disc = rule.discountType === 'PERCENTAGE' ? (totals.subtotal * val) / 100 : val;
        setBillDiscount(Math.round(disc * 100) / 100);
        setDiscountInput('');
        setAppliedDiscounts((prev) => {
          const filtered = prev.filter((a) => a.ruleId !== ruleId);
          return [...filtered, { ruleId, amount: Math.round(disc * 100) / 100 }];
        });
        setError('');
        return;
      }

      const lineDiscounts = new Map<string, number>();
      for (const line of cart) {
        const match =
          (rule.productId && rule.productId === line.product.id) ||
          (rule.categoryId && line.product.category?.id === rule.categoryId);
        if (!match) continue;
        const lineSub = line.quantity * line.unitPrice;
        const val = parseFloat(rule.value);
        const disc = rule.discountType === 'PERCENTAGE' ? (lineSub * val) / 100 : val;
        lineDiscounts.set(line.product.id, (lineDiscounts.get(line.product.id) ?? 0) + disc);
      }
      setCart((prev) =>
        prev.map((l) => ({
          ...l,
          discountAmount: lineDiscounts.get(l.product.id) ?? l.discountAmount,
        })),
      );
      setError('');
    },
    [cart, discountRules, totals.subtotal, currency],
  );

  const applyManualDiscount = () => {
    const val = parseFloat(discountInput) || 0;
    if (val <= 0) return;
    let disc = val;
    if (!canDiscountUnlimited && maxDiscountPercent != null) {
      const maxAllowed = (totals.subtotal * maxDiscountPercent) / 100;
      if (disc > maxAllowed) {
        setError(
          `Max discount allowed: ${maxDiscountPercent}% (${formatMoney(maxAllowed, currency)})`,
        );
        disc = maxAllowed;
      }
    }
    setBillDiscount(Math.round(disc * 100) / 100);
    setSelectedRuleId('');
    setAppliedDiscounts([]);
    setError('');
  };

  const handleBarcode = async (value: string) => {
    if (!value.trim()) return;
    try {
      addToCart(await api.products.byBarcode(value.trim()));
    } catch {
      setSearch(value);
      setShowDropdown(true);
    }
  };

  useEffect(() => {
    safeFocus(searchRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        safeFocus(searchRef.current, { force: true });
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Enter' && barcodeBuffer.current.length >= 4) {
        void handleBarcode(barcodeBuffer.current);
        barcodeBuffer.current = '';
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        barcodeBuffer.current += e.key;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          barcodeBuffer.current = '';
        }, 100);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addToCart]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    if (paymentMode === 'CREDIT') {
      setCreditAmount(String(totals.grandTotal));
      setCashAmount('0');
      setAmountReceived('');
      return;
    }
    if (paymentMode === 'SPLIT' && cashAmount !== '') {
      const cash = Math.min(Math.max(0, parseFloat(cashAmount) || 0), totals.grandTotal);
      setCreditAmount(String(Math.max(0, Math.round((totals.grandTotal - cash) * 100) / 100)));
      setAmountReceived(String(cash));
    }
  }, [paymentMode, totals.grandTotal, cashAmount]);

  const availablePaymentModes = useMemo((): PaymentMode[] => {
    if (!customer) return ['CASH'];
    return ['CASH', 'CREDIT', 'SPLIT'];
  }, [customer]);

  useEffect(() => {
    if (!availablePaymentModes.includes(paymentMode)) {
      setPaymentMode('CASH');
      setAmountReceived('');
      setCashAmount('');
      setCreditAmount('');
    }
  }, [availablePaymentModes, paymentMode]);

  // Exchange credit only applies on cash checkout.
  useEffect(() => {
    if (exchangeCredit > 0 && paymentMode !== 'CASH') {
      setPaymentMode('CASH');
      setCashAmount('');
      setCreditAmount('');
      setAmountReceived('');
    }
  }, [exchangeCredit, paymentMode]);

  const clearSale = () => {
    setCart([]);
    setCustomer(null);
    setCustomerSearch('');
    setBillDiscount(0);
    setDiscountInput('');
    setSelectedRuleId('');
    setAppliedDiscounts([]);
    setNotes('');
    setPaymentMode('CASH');
    setCashAmount('');
    setCreditAmount('');
    setAmountReceived('');
    setError('');
    setWarning('');
    setConfirmCancel(false);
    setExchangeBanner(null);
  };

  const cancelSale = () => {
    if (cart.length === 0) return;
    setConfirmCancel(true);
  };

  const buildSalePayload = (opts?: { allowSplit?: boolean }) => {
    const body: Record<string, unknown> = {
      customerId: customer?.id,
      paymentMethod: paymentMode === 'SPLIT' ? 'SPLIT' : paymentMode,
      items: cart.map((l) => ({
        productId: l.product.id,
        quantity:
          l.saleMode === 'WHOLE'
            ? 1
            : isBatchProduct(l.product)
              ? roundSoldQty(l.quantity)
              : l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount,
        ...(l.customName ? { productName: l.customName } : {}),
        ...(l.batchId ? { batchId: l.batchId } : {}),
        ...(l.saleMode ? { saleMode: l.saleMode } : {}),
      })),
      billDiscountAmount: billDiscount,
      appliedDiscounts: appliedDiscounts.length > 0 ? appliedDiscounts : undefined,
      notes: notes || undefined,
      allowSplitBatches: opts?.allowSplit ?? allowSplitBatches,
      printReceipt: resolveReceiptAfterSale({
        userId: user?.id,
        shopShow: settings?.showReceiptAfterSale,
        shopPrint: settings?.printReceiptsDefault,
        canPrint,
      }).autoPrint,
    };
    if (paymentMode === 'SPLIT') {
      const cash = parseFloat(cashAmount) || 0;
      body.cashAmount = cash;
      body.creditAmount = Math.max(0, Math.round((totals.grandTotal - cash) * 100) / 100);
      // Same figure as cash given — no second tender entry.
      body.amountReceived = cash;
    }
    if (paymentMode === 'CASH') {
      const due = exchangeCredit > 0 ? payableAfterExchange : totals.grandTotal;
      const received = parseFloat(amountReceived);
      body.amountReceived = Number.isFinite(received) ? received : due === 0 ? 0 : 0;
      if (exchangeCredit > 0) {
        body.exchangeCreditAmount = exchangeCredit;
      }
    }
    return body;
  };

  const resetRegisterAfterSale = () => {
    setCart([]);
    setCustomer(null);
    setCustomerSearch('');
    setBillDiscount(0);
    setDiscountInput('');
    setSelectedRuleId('');
    setAppliedDiscounts([]);
    setNotes('');
    setPaymentMode('CASH');
    setAmountReceived('');
    setCashAmount('');
    setCreditAmount('');
    setExchangeBanner(null);
  };

  const completeSale = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      try {
        return await api.sales.create(body);
      } catch (err) {
        // Re-sync stock so UI matches server after a failed checkout.
        void queryClient.invalidateQueries({ queryKey: ['products'] });
        void queryClient.invalidateQueries({ queryKey: ['batches'] });
        void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
        throw err;
      }
    },
    onMutate: () => {
      setError('');
      setWarning('');
    },
    onSuccess: (result) => {
      // Keep checkout open until save succeeds, flash confirmation, then receipt.
      setSaleSuccessFlash(true);
      toast.success('Sale completed successfully!');
      const detail = result.detail;
      const creditWarn = result.creditLimitWarning;

      // Optimistically reduce stock in cached product lists from this cart.
      queryClient.setQueriesData<{ data?: Product[] }>({ queryKey: ['products'] }, (prev) => {
        if (!prev?.data) return prev;
        const qtyById = new Map<string, number>();
        for (const line of cart) {
          if (!line.product.trackStock) continue;
          const deducted =
            line.saleMode === 'WHOLE' && line.batchStockDeduct != null
              ? line.batchStockDeduct
              : line.quantity;
          qtyById.set(line.product.id, (qtyById.get(line.product.id) ?? 0) + deducted);
        }
        if (qtyById.size === 0) return prev;
        return {
          ...prev,
          data: prev.data.map((p) => {
            const sold = qtyById.get(p.id);
            if (sold == null) return p;
            const next = Math.max(0, parseFloat(p.stockQuantity) - sold);
            return { ...p, stockQuantity: String(next) };
          }),
        };
      });
      setAllowSplitBatches(false);
      pendingSaleBodyRef.current = null;

      // Optimistically reduce open-batch remaining so Inventory updates immediately.
      queryClient.setQueriesData<ProductBatch[]>({ queryKey: ['batches'] }, (prev) => {
        if (!Array.isArray(prev)) return prev;
        const deductByBatch = new Map<string, number>();
        for (const line of cart) {
          if (!needsBatchSaleModal(line.product) || !line.batchId) continue;
          if (line.saleMode === 'WHOLE') {
            deductByBatch.set(line.batchId, Number.POSITIVE_INFINITY);
            continue;
          }
          const deducted = line.quantity;
          deductByBatch.set(line.batchId, (deductByBatch.get(line.batchId) ?? 0) + deducted);
        }
        if (deductByBatch.size === 0) return prev;
        return prev
          .map((b) => {
            const d = deductByBatch.get(b.id);
            if (d == null) return b;
            if (d === Number.POSITIVE_INFINITY) {
              return { ...b, remainingQuantity: '0.000', status: 'CLOSED' as const };
            }
            const next = Math.max(0, parseFloat(b.remainingQuantity) - d);
            return {
              ...b,
              remainingQuantity: next.toFixed(3),
              status: next <= 0.1 ? ('CLOSED' as const) : b.status,
            };
          })
          .filter((b) => b.status === 'OPEN' || !deductByBatch.has(b.id));
      });

      window.setTimeout(() => {
        setSaleSuccessFlash(false);
        setShowCheckout(false);
        resetRegisterAfterSale();

        if (creditWarn) {
          setWarning(creditWarn);
          toast.info(creditWarn);
        }

        if (detail) {
          const { showReceipt, autoPrint } = resolveReceiptAfterSale({
            userId: user?.id,
            shopShow: settings?.showReceiptAfterSale,
            shopPrint: settings?.printReceiptsDefault,
            canPrint,
          });
          if (showReceipt) {
            setReceiptSale(detail);
          }
          if (autoPrint) {
            void printSaleReceipt(detail, settings!, currency).catch((err) => {
              const msg = err instanceof Error ? err.message : 'Receipt print failed';
              setWarning(msg);
              toast.error(msg);
            });
          }
        } else {
          void api.sales
            .get(result.sale.id)
            .then((sale) => {
              const { showReceipt, autoPrint } = resolveReceiptAfterSale({
                userId: user?.id,
                shopShow: settings?.showReceiptAfterSale,
                shopPrint: settings?.printReceiptsDefault,
                canPrint,
              });
              if (showReceipt) setReceiptSale(sale);
              if (autoPrint && settings) {
                void printSaleReceipt(sale, settings, currency).catch((err) => {
                  const msg = err instanceof Error ? err.message : 'Receipt print failed';
                  setWarning(msg);
                  toast.error(msg);
                });
              }
            })
            .catch(() => {
              setError('Sale saved, but receipt failed to load');
              toast.error('Sale saved, but receipt failed to load');
            });
        }

        // Defer heavy refreshes so closing checkout feels instant.
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
          void queryClient.invalidateQueries({ queryKey: ['sales'] });
          void queryClient.invalidateQueries({ queryKey: ['customers'] });
          void queryClient.invalidateQueries({ queryKey: ['products'] });
          void queryClient.invalidateQueries({ queryKey: ['batches'] });
          void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
        }, 0);
      }, 350);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'BATCH_SPLIT_REQUIRED') {
        pendingSaleBodyRef.current = buildSalePayload({ allowSplit: true });
        setSplitConfirmMessage(err.message);
        setSplitConfirmOpen(true);
        return;
      }
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Sale failed — check API connection and try again';
      setError(message);
      toast.error(message);
      // Keep checkout open; re-enable Authorize via isPending clearing.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
    },
  });

  const holdCart = useMutation({
    mutationFn: (name: string) =>
      api.heldCarts.save({
        name: name.trim() || `Hold ${new Date().toLocaleTimeString()}`,
        cartData: {
          cart,
          customer,
          customerSearch,
          paymentMode,
          billDiscount,
          discountInput,
          selectedRuleId,
          appliedDiscounts,
          notes,
          cashAmount,
          creditAmount,
          heldTotal: totals.grandTotal,
        },
      }),
    onSuccess: () => {
      setCart([]);
      setCustomer(null);
      setCustomerSearch('');
      setBillDiscount(0);
      setDiscountInput('');
      setSelectedRuleId('');
      setAppliedDiscounts([]);
      setNotes('');
      setAmountReceived('');
      setShowHoldModal(false);
      setHoldLabel('');
      setHoldMessage('Bill held — you can resume it from Held Bills.');
      setTimeout(() => setHoldMessage(''), 4000);
      void refetchHeld();
    },
  });

  const deleteHeld = useMutation({
    mutationFn: (id: string) => api.heldCarts.delete(id),
    onSuccess: async () => {
      setDeleteHeldTarget(null);
      const result = await refetchHeld();
      const remaining = result.data?.length ?? 0;
      if (remaining === 0) setShowHeld(false);
    },
  });

  const resumeHeld = (held: HeldCart) => {
    const data = held.cartData as {
      cart?: CartLine[];
      customer?: Customer;
      customerSearch?: string;
      paymentMode?: PaymentMode;
      paymentMethod?: string;
      billDiscount?: number;
      discountInput?: string;
      selectedRuleId?: string;
      appliedDiscounts?: Array<{ ruleId: string; amount: number }>;
      notes?: string;
      cashAmount?: string;
      creditAmount?: string;
    };
    if (data.cart) {
      setCart(
        data.cart.map((l, i) => ({
          ...l,
          key: l.key || (l.customName ? `misc-held-${i}` : l.product.id),
        })),
      );
    }
    if (data.customer) setCustomer(data.customer);
    if (data.customerSearch) setCustomerSearch(data.customerSearch);
    else if (data.customer) setCustomerSearch(data.customer.name);
    else setCustomerSearch('');
    if (data.paymentMode) setPaymentMode(data.paymentMode);
    else if (data.paymentMethod === 'CREDIT') setPaymentMode('CREDIT');
    else if (data.paymentMethod === 'SPLIT') setPaymentMode('SPLIT');
    if (data.billDiscount) setBillDiscount(data.billDiscount);
    if (data.discountInput) setDiscountInput(data.discountInput);
    if (data.selectedRuleId) setSelectedRuleId(data.selectedRuleId);
    if (data.appliedDiscounts) setAppliedDiscounts(data.appliedDiscounts);
    if (data.notes) setNotes(data.notes);
    if (data.cashAmount) setCashAmount(data.cashAmount);
    if (data.creditAmount) setCreditAmount(data.creditAmount);
    setAmountReceived('');
    setError('');
    void api.heldCarts.delete(held.id).then(() => refetchHeld());
    setShowHeld(false);
    safeFocus(searchRef.current);
  };

  const searchResults = useMemo(() => {
    if (useCustomQuickPick) {
      const favorites = quickPickPage?.data ?? [];
      const seen = new Set(favorites.map((p) => p.id));
      const fill = (searchPage?.data ?? [])
        .filter((p) => !seen.has(p.id))
        .slice(0, Math.max(0, SALE_SEARCH_LIMIT - favorites.length));
      return [...favorites, ...fill];
    }
    const rows = searchPage?.data ?? [];
    const q = search.trim();
    // Instant local filter while debounce/API catch up.
    const filtered = q ? rows.filter((p) => productMatchesSearch(p, q)) : rows;
    if (q || categoryId) return filtered;
    return [...filtered].sort((a, b) => {
      const score = (p: Product) => {
        if (!p.trackStock) return 0;
        const qty = parseFloat(p.stockQuantity);
        if (qty > 0) return 1;
        return 2;
      };
      const d = score(a) - score(b);
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    });
  }, [searchPage?.data, search, categoryId, useCustomQuickPick, quickPickPage?.data]);
  const productsFetching = useCustomQuickPick
    ? quickPickLoading ||
      (quickPickFetching && (quickPickPage?.data?.length ?? 0) === 0 && searchResults.length === 0)
    : searchLoading || (searchFetching && searchResults.length === 0);
  const cashDue = useMemo(() => {
    if (paymentMode === 'CASH') {
      return exchangeCredit > 0 ? payableAfterExchange : totals.grandTotal;
    }
    if (paymentMode === 'SPLIT') return parseFloat(cashAmount) || 0;
    return 0;
  }, [paymentMode, totals.grandTotal, cashAmount, exchangeCredit, payableAfterExchange]);

  const changeDue = useMemo(() => {
    const received = parseFloat(amountReceived) || 0;
    const tenderChange =
      cashDue <= 0 || received < cashDue ? 0 : Math.round((received - cashDue) * 100) / 100;
    // Unused exchange credit must be handed back as cash.
    return Math.round((tenderChange + (exchangeRemaining > 0 ? exchangeRemaining : 0)) * 100) / 100;
  }, [amountReceived, cashDue, exchangeRemaining]);

  const needsCashTender = paymentMode === 'CASH' && cashDue > 0;
  const splitCashOk =
    paymentMode !== 'SPLIT' ||
    (cashAmount !== '' &&
      (parseFloat(cashAmount) || 0) >= 0 &&
      (parseFloat(cashAmount) || 0) < totals.grandTotal);
  const cashTenderOk =
    (!needsCashTender || (parseFloat(amountReceived) || 0) >= cashDue) && splitCashOk;

  const canAuthorize =
    cart.length > 0 &&
    cashTenderOk &&
    (paymentMode !== 'CREDIT' || !!customer) &&
    (paymentMode !== 'SPLIT' || !!customer);
  const canOpenCheckout =
    cart.length > 0 &&
    (paymentMode !== 'CREDIT' || !!customer) &&
    (paymentMode !== 'SPLIT' || !!customer);
  const browseProducts = searchResults;
  const selectedCustomerLabel = customer?.name ?? 'Walk-in Customer (Cash Sale)';

  const paymentModeLabels: Record<PaymentMode, string> = {
    CASH: 'Cash Sale',
    CREDIT: 'Full Udhaar',
    SPLIT: 'Split Udhaar',
  };

  const openCheckout = () => {
    setError('');
    if (!canOpenCheckout) {
      setError('Customer is required for udhaar or split payment.');
      setMobileCartOpen(true);
      return;
    }
    const due = exchangeCredit > 0 ? payableAfterExchange : totals.grandTotal;
    // Fully covered by exchange — no cash to collect.
    setAmountReceived(paymentMode === 'CASH' && due === 0 ? '0' : '');
    setMobileCartOpen(false);
    setShowCheckout(true);
  };

  const authorizeCheckout = () => {
    if (completeSale.isPending || saleSuccessFlash) return;
    setError('');
    if (!cashTenderOk) {
      const msg =
        exchangeCredit > 0
          ? 'Enter the extra cash collected from the customer.'
          : 'Enter the amount received from the customer.';
      setError(msg);
      toast.error(msg);
      return;
    }
    if (!canAuthorize) return;
    completeSale.mutate(buildSalePayload());
  };

  // Enter → Proceed to Payment (when not typing in product search).
  useEffect(() => {
    if (showCheckout || cart.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLInputElement && target === searchRef.current) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      e.preventDefault();
      openCheckout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCheckout, cart.length, canOpenCheckout, paymentMode, customer]);

  // Enter → Authorize Checkout while payment modal is open.
  useEffect(() => {
    if (!showCheckout || saleSuccessFlash) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      authorizeCheckout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCheckout, saleSuccessFlash, canAuthorize, cashTenderOk, completeSale.isPending]);

  const openHoldModal = () => {
    if (cart.length === 0) return;
    const defaultName =
      customer?.name ??
      `Hold ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    setHoldLabel(defaultName);
    setShowHoldModal(true);
  };

  const setQuickTender = (value: number) => {
    setAmountReceived(String(Math.max(value, cashDue)));
  };

  const customerDisplay = customerSearch || (customer ? customer.name : '');

  useEffect(() => {
    if (cart.length === 0) setMobileCartOpen(false);
  }, [cart.length]);

  useEffect(() => {
    if (!mobileCartOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileCartOpen]);

  useEffect(() => {
    if (!mobileCartOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileCartOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileCartOpen]);

  const proceedPaymentLabel =
    exchangeCredit > 0 && payableAfterExchange === 0
      ? exchangeRemaining > 0
        ? `Return ${formatMoney(exchangeRemaining, currency)} & finish`
        : 'Complete exchange'
      : exchangeCredit > 0
        ? `Collect ${formatMoney(payableAfterExchange, currency)}`
        : 'Proceed to Payment';

  const displayTotal = exchangeCredit > 0 ? payableAfterExchange : totals.grandTotal;

  const renderCartLines = () =>
    cart.length === 0 ? (
      <div className="flex h-full min-h-[120px] items-center justify-center">
        <p className="text-center text-xs text-text-muted">Add products from the register</p>
      </div>
    ) : (
      <div className="space-y-2">
        {cart.map((line) => {
          const batch = needsBatchSaleModal(line.product);
          const wholeBatch = line.saleMode === 'WHOLE';
          return (
            <div
              key={line.key}
              className="rounded-xl border border-border/80 bg-surface-muted/60 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 text-sm font-medium leading-tight">
                  {line.customName ?? line.product.name}
                </p>
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-danger"
                  onClick={() => setCart((c) => c.filter((l) => l.key !== line.key))}
                >
                  ✕
                </button>
              </div>
              <p className="mt-0.5 text-[10px] text-text-muted">
                {wholeBatch ? (
                  <>
                    {formatMoney(line.unitPrice, currency)} whole batch
                    {line.batchStockDeduct
                      ? ` · ${line.batchStockDeduct} ${line.product.unit} stock`
                      : ''}
                  </>
                ) : (
                  <>
                    {formatMoney(line.unitPrice, currency)} / {line.product.unit} ×{' '}
                    {formatQty(line.quantity)}
                  </>
                )}
                {line.customName ? ' · Other' : ''}
                {batch && line.batchLabel ? ` · ${line.batchLabel}` : ''}
                {!wholeBatch && batch ? ' · Loose' : ''}
              </p>
              {batch ? (
                <div className="mt-2 space-y-1.5">
                  {wholeBatch ? (
                    <p className="text-[10px] text-text-muted">
                      Fixed whole-batch price — all stock on this batch is removed
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="block text-[10px] text-text-muted">
                        Qty ({line.product.unit})
                        <input
                          type="number"
                          step="0.01"
                          className="mt-0.5 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm font-semibold"
                          value={line.quantity}
                          onChange={(e) => {
                            const q = roundSoldQty(parseFloat(e.target.value) || 0);
                            setCart((c) =>
                              c.map((l) => (l.key === line.key ? { ...l, quantity: Math.max(0.01, q) } : l)),
                            );
                          }}
                        />
                      </label>
                      <label className="block text-[10px] text-text-muted">
                        Amount ({currency})
                        <input
                          type="number"
                          step="0.01"
                          className="mt-0.5 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm font-semibold"
                          value={amountFromQty(line.quantity, line.unitPrice)}
                          onChange={(e) => {
                            const amt = parseFloat(e.target.value) || 0;
                            const q = qtyFromAmount(amt, line.unitPrice);
                            setCart((c) =>
                              c.map((l) =>
                                l.key === line.key ? { ...l, quantity: Math.max(0.01, q) } : l,
                              ),
                            );
                          }}
                        />
                      </label>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-[10px] font-semibold text-brand-700"
                      onClick={() => void openBatchEntry(line.product, line)}
                    >
                      Change batch
                    </button>
                    <span className="text-sm font-bold text-brand-700">
                      {formatMoney(line.quantity * line.unitPrice - line.discountAmount, currency)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-white text-sm font-bold"
                    onClick={() =>
                      setCart((c) =>
                        c.map((l) =>
                          l.key === line.key ? { ...l, quantity: Math.max(1, l.quantity - 1) } : l,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <span className="min-w-[24px] text-center text-sm font-semibold">
                    {formatQty(line.quantity)}
                  </span>
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-white text-sm font-bold"
                    onClick={() => {
                      if (canAddToCart(line.product, 1, line.quantity)) {
                        setCart((c) =>
                          c.map((l) => (l.key === line.key ? { ...l, quantity: l.quantity + 1 } : l)),
                        );
                      } else setError('Insufficient stock');
                    }}
                  >
                    +
                  </button>
                  <span className="ml-auto text-sm font-bold text-brand-700">
                    {formatMoney(line.quantity * line.unitPrice - line.discountAmount, currency)}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );

  const renderCustomerPicker = () => (
    <div className="relative">
      <input
        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        placeholder="Walk-in Customer (Cash Sale)"
        value={customerDisplay}
        autoComplete="off"
        onChange={(e) => {
          const v = e.target.value;
          setCustomerSearch(v);
          if (!v) {
            setCustomer(null);
            setPaymentMode('CASH');
          }
          setShowCustomerDropdown(true);
        }}
        onFocus={() => setShowCustomerDropdown(true)}
      />
      {showCustomerDropdown && customerSearch && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-36 overflow-y-auto rounded-lg border border-border bg-white shadow-lg">
          {customerSearch.trim().length < 2 ? (
            <p className="px-3 py-2 text-xs text-text-muted">Type at least 2 characters…</p>
          ) : customersFetching && !customers?.data?.length ? (
            <p className="px-3 py-2 text-xs text-text-muted">Searching…</p>
          ) : (
            <>
              {(customers?.data ?? [])
                .filter((c) => customerMatchesSearch(c, customerSearch))
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="block w-full px-3 py-2 text-left text-xs hover:bg-brand-50"
                    onClick={() => {
                      setCustomer(c);
                      setCustomerSearch(c.name);
                      setShowCustomerDropdown(false);
                    }}
                  >
                    <span className="font-medium">{c.name}</span>
                    {c.phone && <span className="text-text-muted"> · {c.phone}</span>}
                  </button>
                ))}
              {(customers?.data ?? []).filter((c) => customerMatchesSearch(c, customerSearch))
                .length === 0 && (
                <p className="px-3 py-2 text-xs text-text-muted">
                  No customer found. Add from Udhaar page.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  const renderDiscountControls = (compact = false) =>
    canDiscount ? (
      <div className={`flex gap-2 ${compact ? '' : 'mb-3'}`}>
        {discountRules && discountRules.length > 0 ? (
          <Select
            value={selectedRuleId}
            onChange={(e) => applyDiscountRule(e.target.value)}
            options={[
              { value: '', label: 'Discount rule...' },
              ...discountRules.map((r) => ({
                value: r.id,
                label: `${r.name} (${r.discountType === 'PERCENTAGE' ? `${r.value}%` : `Rs ${r.value}`})`,
              })),
            ]}
            className="flex-1"
          />
        ) : (
          <Input
            type="number"
            min={0}
            className="flex-1"
            value={discountInput}
            onChange={(e) => setDiscountInput(e.target.value)}
            placeholder="Discount"
          />
        )}
        <Button size="sm" variant="secondary" onClick={applyManualDiscount}>
          Apply
        </Button>
      </div>
    ) : null;

  return (
    <div
      className={`relative flex min-h-[calc(100dvh-8.5rem)] flex-1 flex-col md:h-full md:min-h-0 md:overflow-hidden ${
        cart.length > 0 ? (canDiscount ? 'pb-[14.5rem] lg:pb-0' : 'pb-[11.5rem] lg:pb-0') : ''
      }`}
    >
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-text">Sales Register</h1>
        <div className="flex flex-wrap gap-2">
          {canHoldBills && (heldCarts?.length ?? 0) > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setShowHeld(true)}>
              Held bills ({heldCarts?.length})
            </Button>
          )}
          {cart.length > 0 && (
            <>
              {canHoldBills && (
                <Button size="sm" variant="secondary" onClick={openHoldModal}>
                  Hold bill
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={cancelSale}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {holdMessage && (
        <div className="mb-3 shrink-0 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800">
          {holdMessage}
        </div>
      )}

      {exchangeBanner && exchangeCredit > 0 && (
        <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Exchange from bill {exchangeBanner.exchangeFromSaleNumber}
            </p>
            <div className="mt-2 grid gap-1 text-amber-900/90 sm:grid-cols-3">
              <p>
                Exchange credit: <strong>{formatMoney(exchangeCredit, currency)}</strong>
              </p>
              <p>
                Applied to cart: <strong>{formatMoney(exchangeApplied, currency)}</strong>
              </p>
              {payableAfterExchange > 0 ? (
                <p>
                  Collect from customer:{' '}
                  <strong className="text-rose-700">
                    {formatMoney(payableAfterExchange, currency)}
                  </strong>
                </p>
              ) : (
                <p>
                  Return cash to customer:{' '}
                  <strong className="text-emerald-800">
                    {formatMoney(exchangeRemaining, currency)}
                  </strong>
                </p>
              )}
            </div>
            <p className="mt-1 text-xs text-amber-900/70">
              {payableAfterExchange > 0
                ? 'New items cost more than the exchange — only collect the difference.'
                : exchangeRemaining > 0
                  ? 'New items cost less — hand the remaining exchange amount back in cash.'
                  : 'New items match the exchange credit — no cash to collect or return.'}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setExchangeBanner(null)}>
            Clear credit
          </Button>
        </div>
      )}

      {completeSale.isPending && (
        <div className="mb-3 shrink-0 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800">
          Completing sale…
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_360px] lg:overflow-hidden xl:grid-cols-[1fr_400px]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 lg:min-h-0">
          <Card className="border-border/80 bg-white" padding="md">
            <div className="relative" ref={dropdownRef}>
              <IconSearch className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                ref={searchRef}
                className="w-full rounded-xl border border-border bg-surface-muted py-2.5 pl-10 pr-3 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                placeholder="Search by Name, SKU code or scan Barcode..."
                value={search}
                autoComplete="off"
                inputMode="search"
                enterKeyHint="search"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchResults[0]) addToCart(searchResults[0]);
                  if (e.key === 'Enter' && search.trim()) void handleBarcode(search);
                }}
              />
              {showDropdown && search.length >= 1 && (
                <div
                  className={`absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-white shadow-lg ${productsFetching ? 'opacity-80' : ''}`}
                >
                  {searchResults.length === 0 && (
                    <p className="px-3 py-2 text-xs text-text-muted">
                      {productsFetching ? 'Loading products…' : 'No products found'}
                    </p>
                  )}
                  {searchResults.map((p) => {
                    const status = getStockStatus(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={status === 'out'}
                        onClick={() => addToCart(p)}
                        className="flex w-full items-center justify-between border-b border-border/50 px-3 py-2 text-left hover:bg-brand-50 disabled:opacity-50"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {canUseProductImages && p.imageUrl && (
                            <img
                              src={p.imageUrl}
                              alt=""
                              className="h-10 w-10 shrink-0 rounded-lg border border-border bg-white object-cover"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{p.name}</p>
                            <p className="text-[11px] text-text-muted">
                              {p.sku ?? '—'} {p.barcode && `· ${p.barcode}`}
                            </p>
                          </div>
                        </div>
                        <div className="ml-3 text-right">
                          <p className="text-sm font-semibold text-brand-700">
                            {formatMoney(p.sellPrice, currency)}
                          </p>
                          {p.trackStock && (
                            <Badge
                              variant={
                                status === 'low'
                                  ? 'warning'
                                  : status === 'out'
                                    ? 'danger'
                                    : 'default'
                              }
                            >
                              {formatSaleStockBadge(p)}
                            </Badge>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCategoryId('')}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                  !categoryId
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-border bg-white text-text'
                }`}
              >
                All
              </button>
              {(categories ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                    categoryId === c.id
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-border bg-white text-text'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </Card>

          <Card className="bg-white" padding="md">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {!categoryId && !search.trim()
                  ? useCustomQuickPick
                    ? 'Your Quick pick'
                    : 'Quick pick'
                  : categoryId
                    ? 'Category products'
                    : 'Search results'}
              </h3>
              <div className="flex items-center gap-2">
                {canCustomize && !categoryId && !search.trim() && (
                  <button
                    type="button"
                    className="text-xs font-semibold text-brand-700 hover:underline"
                    onClick={() => setShowQuickPickCustomize(true)}
                  >
                    Customize
                  </button>
                )}
                <span className="text-xs text-text-muted">{browseProducts.length} items</span>
              </div>
            </div>
            {productsFetching && browseProducts.length === 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="skeleton-shine h-[116px] rounded-2xl bg-surface-muted" />
                ))}
              </div>
            ) : browseProducts.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-muted">
                {search.trim()
                  ? 'No products match your search.'
                  : 'No products available yet — add items in Inventory.'}
              </p>
            ) : (
              <div
                className={`grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-4 ${productsFetching ? 'opacity-70' : ''}`}
              >
                {browseProducts.map((p) => {
                  const status = getStockStatus(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={status === 'out'}
                      onClick={() => addToCart(p)}
                      className={`flex flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition hover:border-brand-300 hover:shadow-sm disabled:opacity-50 ${
                        canUseProductImages && p.imageUrl ? 'min-h-[174px]' : 'min-h-[108px] p-2.5'
                      }`}
                    >
                      {canUseProductImages && p.imageUrl && (
                        <div className="relative h-24 w-full overflow-hidden bg-surface-muted">
                          <img
                            src={p.imageUrl}
                            alt=""
                            aria-hidden="true"
                            className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl saturate-150"
                          />
                          <img
                            src={p.imageUrl}
                            alt={p.name}
                            className="absolute inset-0 h-full w-full object-cover"
                            style={{
                              WebkitMaskImage:
                                'radial-gradient(ellipse 68% 72% at center, black 48%, transparent 100%)',
                              maskImage:
                                'radial-gradient(ellipse 68% 72% at center, black 48%, transparent 100%)',
                            }}
                          />
                        </div>
                      )}
                      <div
                        className={
                          canUseProductImages && p.imageUrl
                            ? 'flex min-h-0 flex-1 flex-col px-2.5 py-2'
                            : 'flex min-h-0 flex-1 flex-col'
                        }
                      >
                        <div className="min-w-0">
                          <span className="block text-[9px] uppercase tracking-[0.14em] text-text-muted">
                            {p.category?.name ?? 'General'}
                          </span>
                          <span className="mt-0.5 line-clamp-2 text-xs font-semibold leading-snug">
                            {p.name}
                          </span>
                        </div>
                        <div className="mt-auto flex items-end justify-between gap-1.5 pt-2 text-[11px]">
                          <div>
                            <span className="block font-semibold text-brand-700">
                              {formatMoney(p.sellPrice, currency)}
                            </span>
                            <span className="text-[10px] text-text-muted">/ {p.unit}</span>
                          </div>
                          {p.trackStock && (
                            <Badge variant={status === 'low' ? 'warning' : 'default'}>
                              {formatSaleStockBadge(p)}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="hidden min-h-0 flex-col rounded-2xl border border-border bg-white shadow-sm lg:flex lg:h-full lg:min-h-0">
          <div className="shrink-0 border-b border-border px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconWallet className="h-4 w-4 text-brand-600" />
                <h3 className="text-sm font-semibold text-text">Shopping Cart</h3>
                <Badge variant="brand">{cart.length}</Badge>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  className="text-xs font-medium text-danger hover:underline"
                  onClick={cancelSale}
                >
                  Clear
                </button>
              )}
            </div>

            {renderCustomerPicker()}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">{renderCartLines()}</div>

          <div className="shrink-0 border-t border-border bg-surface-muted/40 px-4 py-3">
            {renderDiscountControls()}

            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-text-muted">
                <span>Subtotal</span>
                <span>{formatMoney(totals.subtotal, currency)}</span>
              </div>
              {totals.discountTotal > 0 && (
                <div className="flex justify-between text-danger">
                  <span>Discount</span>
                  <span>−{formatMoney(totals.discountTotal, currency)}</span>
                </div>
              )}
              {totals.taxTotal > 0 && (
                <div className="flex justify-between text-text-muted">
                  <span>{settings?.taxLabel ?? 'Tax'}</span>
                  <span>{formatMoney(totals.taxTotal, currency)}</span>
                </div>
              )}
            </div>

            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                Grand Total
              </span>
              <span className="text-xl font-bold text-brand-800">
                {formatMoney(totals.grandTotal, currency)}
              </span>
            </div>

            {exchangeCredit > 0 && (
              <div className="mt-2 space-y-1 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-950">
                <div className="flex justify-between">
                  <span>Exchange credit</span>
                  <span className="font-semibold">−{formatMoney(exchangeApplied, currency)}</span>
                </div>
                {exchangeRemaining > 0 && (
                  <div className="flex justify-between text-emerald-800">
                    <span>Return cash to customer</span>
                    <span className="font-semibold">
                      {formatMoney(exchangeRemaining, currency)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t border-amber-200 pt-1 text-sm font-bold">
                  <span>{payableAfterExchange > 0 ? 'To collect' : 'Cash movement'}</span>
                  <span className={payableAfterExchange > 0 ? 'text-rose-700' : 'text-emerald-800'}>
                    {payableAfterExchange > 0
                      ? formatMoney(payableAfterExchange, currency)
                      : exchangeRemaining > 0
                        ? `−${formatMoney(exchangeRemaining, currency)}`
                        : formatMoney(0, currency)}
                  </span>
                </div>
              </div>
            )}

            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            {warning && <p className="mt-1 text-xs text-slate-600">{warning}</p>}

            <Button
              className="mt-3 w-full"
              size="lg"
              variant="accent"
              disabled={cart.length === 0}
              onClick={openCheckout}
            >
              {proceedPaymentLabel}
            </Button>
          </div>
        </div>
      </div>

      {cart.length > 0 && !showCheckout && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
          <button
            type="button"
            className="mb-2 flex w-full items-center justify-between rounded-xl bg-surface-muted/80 px-3 py-2 text-sm"
            onClick={() => setMobileCartOpen(true)}
          >
            <span className="font-semibold text-text">
              {cart.length} item{cart.length === 1 ? '' : 's'}
              <span className="ml-1.5 font-normal text-text-muted">· View cart</span>
            </span>
            <span className="text-text-muted" aria-hidden>
              ▴
            </span>
          </button>

          {renderDiscountControls(true)}

          <div className="mb-2 mt-2 flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {exchangeCredit > 0 && payableAfterExchange > 0 ? 'To collect' : 'Total'}
            </span>
            <span className="text-lg font-bold text-brand-800">
              {formatMoney(displayTotal, currency)}
            </span>
          </div>

          {error && <p className="mb-2 text-xs text-danger">{error}</p>}

          <Button className="w-full" size="lg" variant="accent" onClick={openCheckout}>
            {proceedPaymentLabel}
          </Button>
        </div>
      )}

      {mobileCartOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close cart"
            onClick={() => setMobileCartOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[75dvh] flex-col rounded-t-2xl border border-border bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <IconWallet className="h-4 w-4 text-brand-600" />
                <h3 className="text-sm font-semibold text-text">Cart</h3>
                <Badge variant="brand">{cart.length}</Badge>
              </div>
              <div className="flex items-center gap-3">
                {cart.length > 0 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-danger hover:underline"
                    onClick={cancelSale}
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  className="text-sm font-semibold text-text-muted"
                  onClick={() => setMobileCartOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="shrink-0 border-b border-border px-4 py-3">
              {renderCustomerPicker()}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{renderCartLines()}</div>
            <div className="shrink-0 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {error && <p className="mb-2 text-xs text-danger">{error}</p>}
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Grand Total
                </span>
                <span className="text-xl font-bold text-brand-800">
                  {formatMoney(displayTotal, currency)}
                </span>
              </div>
              <Button className="w-full" size="lg" variant="accent" onClick={openCheckout}>
                {proceedPaymentLabel}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={showCheckout}
        closeLocked={completeSale.isPending || saleSuccessFlash}
        onClose={() => {
          if (completeSale.isPending || saleSuccessFlash) return;
          setShowCheckout(false);
        }}
        title={
          saleSuccessFlash
            ? 'Sale registered'
            : paymentMode === 'CASH'
              ? 'Cash Sale'
              : paymentMode === 'CREDIT'
                ? 'Credit Sale'
                : paymentMode === 'SPLIT'
                  ? 'Split Payment'
                  : 'Payment Checkout'
        }
        size="md"
        footer={
          saleSuccessFlash ? undefined : (
            <>
              <Button
                variant="ghost"
                disabled={completeSale.isPending}
                onClick={() => {
                  if (completeSale.isPending) return;
                  setShowCheckout(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={completeSale.isPending}
                disabled={!canAuthorize || completeSale.isPending}
                onClick={authorizeCheckout}
              >
                {exchangeCredit > 0 && cashDue === 0
                  ? exchangeRemaining > 0
                    ? `Complete · return ${formatMoney(exchangeRemaining, currency)}`
                    : 'Complete exchange'
                  : exchangeCredit > 0
                    ? `Authorize · collect ${formatMoney(cashDue, currency)}`
                    : 'Authorize Checkout'}
              </Button>
            </>
          )
        }
      >
        {saleSuccessFlash ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700">
              ✓
            </div>
            <p className="text-lg font-bold text-emerald-900">Sale completed successfully!</p>
            <p className="text-sm text-text-muted">Opening receipt…</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-700 px-3.5 py-3 text-white">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                    Invoice total
                  </p>
                  <p className="truncate text-xs text-slate-200">{selectedCustomerLabel}</p>
                </div>
                <p className="shrink-0 text-xl font-bold">
                  {formatMoney(totals.grandTotal, currency)}
                </p>
              </div>
              {exchangeCredit > 0 && (
                <div className="mt-2 space-y-0.5 border-t border-slate-500 pt-2 text-xs text-slate-200">
                  <div className="flex justify-between">
                    <span>Exchange credit</span>
                    <span>−{formatMoney(exchangeApplied, currency)}</span>
                  </div>
                  {exchangeRemaining > 0 && (
                    <div className="flex justify-between text-emerald-300">
                      <span>Return cash</span>
                      <span>{formatMoney(exchangeRemaining, currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-white">
                    <span>{payableAfterExchange > 0 ? 'Cash to collect' : 'Cash to return'}</span>
                    <span>
                      {payableAfterExchange > 0
                        ? formatMoney(payableAfterExchange, currency)
                        : formatMoney(exchangeRemaining, currency)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Payment mode — only when more than cash is available */}
            {exchangeCredit === 0 && availablePaymentModes.length > 1 && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  Payment mode
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {availablePaymentModes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setPaymentMode(mode);
                        setAmountReceived('');
                        if (mode === 'SPLIT') {
                          setCashAmount('');
                          setCreditAmount(String(totals.grandTotal));
                        } else if (mode !== 'CREDIT') {
                          setCashAmount('');
                          setCreditAmount('');
                        }
                      }}
                      className={`rounded-xl border px-2 py-2 text-center text-xs font-semibold transition ${
                        paymentMode === mode
                          ? 'border-brand-700 bg-brand-50 text-brand-800'
                          : 'border-border bg-surface-muted text-text'
                      }`}
                    >
                      {paymentModeLabels[mode]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {paymentMode === 'CASH' && cashDue === 0 && exchangeCredit > 0 && (
              <div
                className={`rounded-xl border px-3 py-3 text-sm ${
                  exchangeRemaining > 0
                    ? 'border-emerald-400 bg-emerald-50 text-emerald-950'
                    : 'border-emerald-300 bg-emerald-50 text-emerald-900'
                }`}
              >
                {exchangeRemaining > 0 ? (
                  <>
                    <p className="text-sm font-semibold">Return cash to customer</p>
                    <p className="mt-1 text-2xl font-bold text-emerald-800">
                      {formatMoney(exchangeRemaining, currency)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm font-medium">No cash to collect or return</p>
                )}
              </div>
            )}

            {paymentMode === 'CASH' && cashDue > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {exchangeCredit > 0
                    ? `Extra cash to collect (${currency})`
                    : `Amount received from customer (${currency})`}
                </p>
                <Input
                  type="number"
                  min={cashDue}
                  step="1"
                  value={amountReceived}
                  onChange={(e) => setAmountReceived(e.target.value)}
                  placeholder={`Due: ${formatMoney(cashDue, currency)}`}
                  autoFocus={prefersDesktopInput()}
                  className="text-base font-semibold"
                />
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    type="button"
                    onClick={() => setQuickTender(cashDue)}
                  >
                    Exact
                  </Button>
                  {[500, 1000, 5000].map((note) => (
                    <Button
                      key={note}
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setQuickTender(roundUpToStep(cashDue, note))}
                    >
                      {formatMoney(note, currency)}
                    </Button>
                  ))}
                </div>
                <div className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  {exchangeCredit > 0 && (
                    <>
                      <div className="mb-1 flex justify-between">
                        <span>Bill total</span>
                        <span className="font-medium">
                          {formatMoney(totals.grandTotal, currency)}
                        </span>
                      </div>
                      <div className="mb-1 flex justify-between">
                        <span>Exchange credit</span>
                        <span className="font-medium">
                          −{formatMoney(exchangeApplied, currency)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between">
                    <span>{exchangeCredit > 0 ? 'Cash due' : 'Bill total'}</span>
                    <span className="font-medium">{formatMoney(cashDue, currency)}</span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span>Received</span>
                    <span className="font-medium">
                      {formatMoney(parseFloat(amountReceived) || 0, currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex justify-between border-t border-emerald-200 pt-1.5 text-base font-bold text-emerald-800">
                    <span>Change back</span>
                    <span>{formatMoney(changeDue, currency)}</span>
                  </div>
                </div>
              </div>
            )}

            {paymentMode === 'CREDIT' && (
              <div className="rounded-xl border border-brand-200 bg-brand-50/70 px-3 py-2.5 text-sm text-brand-900">
                Full invoice will be posted to customer udhaar.
              </div>
            )}

            {paymentMode === 'SPLIT' && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Cash customer is giving now ({currency})
                </p>
                <Input
                  type="number"
                  min={0}
                  max={totals.grandTotal}
                  step="1"
                  value={cashAmount}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCashAmount(raw);
                    const cash = Math.min(Math.max(0, parseFloat(raw) || 0), totals.grandTotal);
                    const credit = Math.max(0, Math.round((totals.grandTotal - cash) * 100) / 100);
                    setCreditAmount(String(credit));
                    setAmountReceived(raw === '' ? '' : String(cash));
                  }}
                  placeholder={`Less than ${formatMoney(totals.grandTotal, currency)}`}
                  autoFocus={prefersDesktopInput()}
                />
                <div className="rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-900">
                  <div className="flex justify-between">
                    <span>Bill total</span>
                    <span className="font-medium">{formatMoney(totals.grandTotal, currency)}</span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span>Cash now</span>
                    <span className="font-medium">
                      {formatMoney(parseFloat(cashAmount) || 0, currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex justify-between border-t border-brand-200 pt-1.5 font-bold">
                    <span>Remaining on udhaar</span>
                    <span>
                      {formatMoney(
                        Math.max(
                          0,
                          Math.round((totals.grandTotal - (parseFloat(cashAmount) || 0)) * 100) /
                            100,
                        ),
                        currency,
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {creditLimitWarning && (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-800">
                {creditLimitWarning}
              </p>
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        )}
      </Modal>

      <Modal
        open={!!receiptSale}
        onClose={() => setReceiptSale(null)}
        title="Sale completed"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReceiptSale(null)}>
              Skip receipt
            </Button>
            {canPrint && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (!receiptSale || !settings) return;
                  void printSaleReceipt(receiptSale, settings, currency).catch((err) => {
                    setError(err instanceof Error ? err.message : 'Receipt print failed');
                  });
                }}
              >
                Print receipt
              </Button>
            )}
            <Button onClick={() => setReceiptSale(null)}>Done</Button>
          </>
        }
      >
        {receiptSale && <ReceiptView sale={receiptSale} currency={currency} />}
      </Modal>

      <Modal
        open={showHoldModal}
        onClose={() => setShowHoldModal(false)}
        title="Hold this bill"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowHoldModal(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={holdCart.isPending}
              onClick={() => holdCart.mutate(holdLabel)}
            >
              Hold bill
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Bill label"
            value={holdLabel}
            onChange={(e) => setHoldLabel(e.target.value)}
            placeholder="e.g. Table 3, Ahmed, or quick note"
          />
          <div className="rounded-xl border border-border bg-surface-muted/60 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">Customer</span>
              <span className="font-medium">{customer?.name ?? 'Walk-in'}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span className="text-text-muted">Items</span>
              <span className="font-medium">
                {cart.length} lines · {cart.reduce((s, l) => s + l.quantity, 0)} pcs
              </span>
            </div>
            <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-bold">
              <span>Total</span>
              <span className="text-brand-800">{formatMoney(totals.grandTotal, currency)}</span>
            </div>
          </div>
          <p className="text-xs text-text-muted">
            The cart will be cleared and saved under Held bills. Resume it anytime from the top bar.
          </p>
        </div>
      </Modal>

      <Modal open={showHeld} onClose={() => setShowHeld(false)} title="Held bills" size="lg">
        <div className="space-y-3">
          {(heldCarts ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-text-muted">No held bills right now.</p>
          )}
          {(heldCarts ?? []).map((h) => {
            const summary = summarizeHeldCart(h.cartData);
            return (
              <div
                key={h.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-text">{h.name ?? 'Held bill'}</p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {summary.customerName} · {summary.lineCount} items ({summary.itemCount} pcs)
                  </p>
                  <p className="text-xs text-text-muted">
                    {new Date(h.updatedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm font-bold text-brand-700">
                    {formatMoney(summary.total, currency)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => resumeHeld(h)}>
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    loading={deleteHeld.isPending}
                    onClick={() => setDeleteHeldTarget(h)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Modal>

      <Modal
        open={batchEntryProduct != null}
        onClose={() => {
          setBatchEntryProduct(null);
          setBatchEntryEditKey(null);
        }}
        title={
          batchEntryEditKey
            ? 'Edit batch sale'
            : `Sell — ${batchEntryProduct?.name ?? ''}`
        }
        footer={
          <>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setBatchEntryProduct(null);
                setBatchEntryEditKey(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={commitBatchEntry} disabled={batchOptionsLoading}>
              {batchEntryEditKey ? 'Update' : 'Add to cart'}
            </Button>
          </>
        }
      >
        {batchEntryProduct && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={batchForm.saleMode === 'LOOSE' ? 'primary' : 'secondary'}
                onClick={() => {
                  if (batchForm.saleMode === 'LOOSE') return;
                  setBatchForm({ saleMode: 'LOOSE', batchId: '', qty: '', amount: '' });
                  void loadBatchOptions(batchEntryProduct, 'LOOSE');
                }}
              >
                Loose
              </Button>
              <Button
                type="button"
                size="sm"
                variant={batchForm.saleMode === 'WHOLE' ? 'primary' : 'secondary'}
                onClick={() => {
                  if (batchForm.saleMode === 'WHOLE') return;
                  setBatchForm({ saleMode: 'WHOLE', batchId: '', qty: '', amount: '' });
                  void loadBatchOptions(batchEntryProduct, 'WHOLE').then((rows) => {
                    if (rows.length === 0) return;
                    const first = rows[0]!;
                    const price = wholeBatchPrice(batchEntryProduct);
                    setBatchForm((prev) => ({
                      ...prev,
                      batchId: first.id,
                      qty: '1',
                      amount: String(price),
                    }));
                  });
                }}
              >
                Whole batch
              </Button>
            </div>
            <p className="text-sm text-text-muted">
              {batchForm.saleMode === 'WHOLE'
                ? 'Sell the full warehouse batch at one fixed price (set in Inventory).'
                : `Sell partial quantity at ${formatMoney(looseUnitPrice(batchEntryProduct), currency)} per ${batchEntryProduct.unit}.`}
            </p>
            {batchOptionsLoading ? (
              <p className="text-sm text-text-muted">
                Loading {batchForm.saleMode === 'WHOLE' ? 'warehouse' : 'open'} batches…
              </p>
            ) : batchOptions.length === 0 ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                {batchForm.saleMode === 'WHOLE'
                  ? 'No warehouse batches. Receive stock for this product in Inventory first.'
                  : 'No open counter batches. Open a warehouse batch for loose sales in Inventory first.'}
              </p>
            ) : (
              <>
                <Select
                  label={batchForm.saleMode === 'WHOLE' ? 'Warehouse batch' : 'Counter batch'}
                  value={batchForm.batchId}
                  onChange={(e) => {
                    const batchId = e.target.value;
                    const selected = batchOptions.find((b) => b.id === batchId);
                    if (batchForm.saleMode === 'WHOLE' && selected) {
                      const price = wholeBatchPrice(batchEntryProduct);
                      setBatchForm({
                        ...batchForm,
                        batchId,
                        qty: '1',
                        amount: String(price),
                      });
                      return;
                    }
                    setBatchForm({ ...batchForm, batchId });
                  }}
                  options={batchOptions.map((b) => ({
                    value: b.id,
                    label: `${formatQty(b.remainingQuantity)} ${batchEntryProduct.unit} left · bought ${b.purchaseDate}${b.supplier ? ` · ${b.supplier}` : ''}`,
                  }))}
                />
                {(() => {
                  const selectedBatch = batchOptions.find((b) => b.id === batchForm.batchId);
                  if (!selectedBatch) return null;
                  const rem = parseFloat(selectedBatch.remainingQuantity) || 0;
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm">
                      <p className="text-brand-900">
                        <strong className="tabular-nums">{formatQty(selectedBatch.remainingQuantity)}</strong>{' '}
                        {batchEntryProduct.unit} left on this batch
                        {selectedBatch.purchaseDate ? (
                          <span className="text-brand-800/80"> · bought {selectedBatch.purchaseDate}</span>
                        ) : null}
                      </p>
                      {batchForm.saleMode === 'LOOSE' && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={rem <= 0}
                          onClick={() => {
                            const price = looseUnitPrice(batchEntryProduct);
                            const qty = roundSoldQty(rem);
                            if (qty <= 0) return;
                            setBatchForm({
                              ...batchForm,
                              qty: String(qty),
                              amount: price > 0 ? String(amountFromQty(qty, price)) : '',
                            });
                          }}
                        >
                          Use remaining
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
            <div className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2 text-sm">
              <p>
                {batchForm.saleMode === 'WHOLE' ? (
                  <>
                    Whole batch price:{' '}
                    <strong className="tabular-nums">
                      {formatMoney(wholeBatchPrice(batchEntryProduct), currency)}
                    </strong>
                  </>
                ) : (
                  <>
                    Retail rate:{' '}
                    <strong className="tabular-nums">
                      {formatMoney(looseUnitPrice(batchEntryProduct), currency)}
                    </strong>
                    {` / ${batchEntryProduct.unit}`}
                  </>
                )}
              </p>
            </div>
            {batchForm.saleMode === 'LOOSE' && (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={`Quantity (${batchEntryProduct.unit})`}
                  type="number"
                  step="0.01"
                  value={batchForm.qty}
                  onChange={(e) => {
                    const qty = e.target.value;
                    const q = parseFloat(qty) || 0;
                    const price = looseUnitPrice(batchEntryProduct);
                    setBatchForm({
                      ...batchForm,
                      qty,
                      amount: q > 0 && price > 0 ? String(amountFromQty(q, price)) : '',
                    });
                  }}
                />
                <Input
                  label={`Amount (${currency})`}
                  type="number"
                  step="0.01"
                  value={batchForm.amount}
                  onChange={(e) => {
                    const amount = e.target.value;
                    const amt = parseFloat(amount) || 0;
                    const price = looseUnitPrice(batchEntryProduct);
                    setBatchForm({
                      ...batchForm,
                      amount,
                      qty: amt > 0 && price > 0 ? String(qtyFromAmount(amt, price)) : '',
                    });
                  }}
                />
              </div>
            )}
            {batchForm.saleMode === 'LOOSE' &&
              (() => {
                const qty = parseFloat(batchForm.qty) || 0;
                const price = looseUnitPrice(batchEntryProduct);
                if (qty <= 0) return null;
                return (
                  <div className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2 text-xs text-text-muted">
                    <p>
                      Customer pays for <strong className="text-text">{roundSoldQty(qty)}</strong>{' '}
                      {batchEntryProduct.unit} (
                      {formatMoney(amountFromQty(roundSoldQty(qty), price), currency)}
                      ). Stock deducts the same quantity.
                    </p>
                  </div>
                );
              })()}
            {batchForm.saleMode === 'WHOLE' && batchForm.batchId && (
              <div className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2 text-xs text-text-muted">
                <p>
                  Customer pays{' '}
                  <strong className="text-text">
                    {formatMoney(wholeBatchPrice(batchEntryProduct), currency)}
                  </strong>{' '}
                  for the whole batch
                  {(() => {
                    const b = batchOptions.find((x) => x.id === batchForm.batchId);
                    return b ? ` (${formatQty(b.remainingQuantity)} ${batchEntryProduct.unit} removed from stock)` : '';
                  })()}
                  .
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={splitConfirmOpen}
        onClose={() => {
          setSplitConfirmOpen(false);
          pendingSaleBodyRef.current = null;
        }}
        onConfirm={() => {
          setSplitConfirmOpen(false);
          setAllowSplitBatches(true);
          const body = pendingSaleBodyRef.current ?? buildSalePayload({ allowSplit: true });
          pendingSaleBodyRef.current = null;
          completeSale.mutate(body);
        }}
        title="Split across batches?"
        message={splitConfirmMessage || 'This sale needs more than one open batch. Continue?'}
        confirmLabel="Split and sell"
        loading={completeSale.isPending}
      />

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={clearSale}
        title="Cancel current sale?"
        message="The cart will be cleared and all items removed. This cannot be undone."
        confirmLabel="Clear cart"
      />

      <ConfirmDialog
        open={deleteHeldTarget != null}
        onClose={() => setDeleteHeldTarget(null)}
        onConfirm={() => {
          if (deleteHeldTarget) deleteHeld.mutate(deleteHeldTarget.id);
        }}
        title="Delete held bill"
        message={
          deleteHeldTarget ? (
            <>
              Delete held bill{' '}
              <strong className="text-text">{deleteHeldTarget.name ?? 'Untitled'}</strong>? This
              cannot be recovered.
            </>
          ) : null
        }
        confirmLabel="Delete bill"
        loading={deleteHeld.isPending}
      />

      <QuickPickCustomizeModal
        open={showQuickPickCustomize}
        onClose={() => setShowQuickPickCustomize(false)}
        initialIds={quickPickIds}
      />
    </div>
  );
}
