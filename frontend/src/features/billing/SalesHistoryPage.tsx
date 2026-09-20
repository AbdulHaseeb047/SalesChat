import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@/lib/next-nav';

import { ReceiptView } from '@/components/billing/ReceiptView';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { PageLoader } from '@/components/ui/Spinner';
import {
  DELETE_SALE_REASON_PRESETS,
  emptyReasonPicker,
  ReasonPicker,
  RETURN_REASON_PRESETS,
  type ReasonPickerValue,
} from '@/features/billing/ReasonPicker';
import { api } from '@/lib/api-client';
import { useDateRangeFilter } from '@/lib/date-range';
import { FEATURES, hasFeature } from '@/lib/features';
import { useAuth } from '@/lib/auth';
import { formatMoney, formatQty } from '@/lib/format';
import { printSaleReceipt } from '@/lib/print-receipt';
import { downloadSaleInvoicePdf, downloadSalesReportPdf } from '@/lib/sales-pdf';
import type { SaleDetail, SaleListItem } from '@/types/api';

import type { ExchangeSaleLocationState } from './exchange-handoff';

const PAGE_SIZE = 15;
const EXCHANGE_DEFAULT_REASON = 'Exchange for different item';

type InvoicePanel = 'receipt' | 'return' | 'exchange' | 'void';

function paymentLabel(sale: SaleListItem) {
  if (sale.payments && sale.payments.length > 0) {
    return sale.payments.map((p) => p.paymentMethod).join(', ');
  }
  return sale.paymentStatus;
}

function paymentBadgeVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const s = status.toUpperCase();
  if (s.includes('PAID') || s === 'CASH') return 'success';
  if (s.includes('PARTIAL') || s.includes('UDHAAR') || s.includes('CREDIT')) return 'warning';
  if (s.includes('VOID')) return 'danger';
  return 'default';
}

export function SalesHistoryPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const returnPanelRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const { range, setRange, customFrom, setCustomFrom, customTo, setCustomTo, selectedMonth, setSelectedMonth, dates } =
    useDateRangeFilter('today');
  const [selected, setSelected] = useState<SaleDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [panel, setPanel] = useState<InvoicePanel>('receipt');
  const [voidReasonPicker, setVoidReasonPicker] = useState<ReasonPickerValue>(emptyReasonPicker());
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [returnReasonPicker, setReturnReasonPicker] =
    useState<ReasonPickerValue>(emptyReasonPicker());
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);

  const canReturn = hasFeature(user, FEATURES.BILLING_CREATE_SALE);
  const canVoid = hasFeature(user, FEATURES.BILLING_VOID_SALE);
  const canPrint = hasFeature(user, FEATURES.BILLING_PRINT_RECEIPT);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [dates.from, dates.to]);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['sales', page, debouncedSearch, dates.from, dates.to],
    queryFn: () =>
      api.sales.list(page, PAGE_SIZE, debouncedSearch || undefined, dates.from, dates.to),
    placeholderData: (prev) => prev,
  });

  const resetReasonState = (startPanel: InvoicePanel = 'receipt') => {
    setVoidReasonPicker(emptyReasonPicker());
    setReturnQty({});
    setReturnReasonPicker(
      startPanel === 'exchange' ? emptyReasonPicker(EXCHANGE_DEFAULT_REASON) : emptyReasonPicker(),
    );
  };

  const openInvoice = async (
    saleId: string,
    startPanel: 'receipt' | 'return' | 'exchange' = 'receipt',
  ) => {
    setLoadingDetail(true);
    setPanel(startPanel);
    try {
      setSelected(await api.sales.get(saleId));
      resetReasonState(startPanel);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openPanel = (next: InvoicePanel) => {
    setPanel(next);
    if (next === 'return') {
      setReturnReasonPicker(emptyReasonPicker());
    } else if (next === 'exchange') {
      setReturnReasonPicker(emptyReasonPicker(EXCHANGE_DEFAULT_REASON));
    } else if (next === 'void') {
      setVoidReasonPicker(emptyReasonPicker());
    }
    if (next === 'return' || next === 'exchange') {
      window.setTimeout(() => returnPanelRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  const closeInvoice = () => {
    setSelected(null);
    setPanel('receipt');
    setConfirmVoid(false);
    setConfirmReturn(false);
  };

  const voidReason = voidReasonPicker.reason;
  const returnReason = returnReasonPicker.reason;

  const voidSale = useMutation({
    mutationFn: () => api.sales.void(selected!.id, voidReason),
    onSuccess: () => {
      closeInvoice();
      setVoidReasonPicker(emptyReasonPicker());
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'aging'] });
    },
  });

  const partialReturn = useMutation({
    mutationFn: () =>
      api.sales.return(selected!.id, {
        reason: returnReason,
        items: Object.entries(returnQty)
          .filter(([, q]) => q > 0)
          .map(([saleItemId, quantity]) => ({ saleItemId, quantity })),
      }),
    onSuccess: async (result) => {
      const wasExchange = panel === 'exchange';
      const saleSnapshot = selected;
      const refundAmount = estimatedRefund;

      if (wasExchange && saleSnapshot) {
        const apiCredit =
          typeof result?.totalAmount === 'string' || typeof result?.totalAmount === 'number'
            ? String(result.totalAmount)
            : String(refundAmount);
        const state: ExchangeSaleLocationState = {
          exchangeFromSaleNumber: saleSnapshot.saleNumber,
          customerId: saleSnapshot.customer?.id ?? null,
          customerName: saleSnapshot.customer?.name ?? null,
          creditHint: apiCredit,
        };
        closeInvoice();
        setReturnQty({});
        setReturnReasonPicker(emptyReasonPicker());
        void queryClient.invalidateQueries({ queryKey: ['sales'] });
        navigate('/pos/sale', { state });
        return;
      }

      if (selected) {
        const refreshed = await api.sales.get(selected.id);
        setSelected(refreshed);
      }
      setReturnQty({});
      setReturnReasonPicker(emptyReasonPicker());
      setConfirmReturn(false);
      setPanel('receipt');
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const currency = settings?.currency ?? 'PKR';
  const sales = data?.data ?? [];
  const meta = data?.meta;

  const canReturnSelected = useMemo(() => {
    if (!selected || selected.status !== 'COMPLETED' || !canReturn) return false;
    return selected.items.some((item) => parseFloat(item.returnableQuantity ?? item.quantity) > 0);
  }, [selected, canReturn]);

  const estimatedRefund = useMemo(() => {
    if (!selected) return 0;
    return selected.items.reduce((sum, item) => {
      const qty = returnQty[item.id] ?? 0;
      if (qty <= 0) return sum;
      const sold = parseFloat(item.quantity);
      const unit = sold > 0 ? parseFloat(item.lineTotal) / sold : 0;
      return sum + unit * qty;
    }, 0);
  }, [selected, returnQty]);

  const hasReturnQty = Object.values(returnQty).some((q) => q > 0);
  const returnReasonReady = returnReason.trim().length > 0;
  const voidReasonReady = voidReason.trim().length > 0;
  const isReturnLike = panel === 'return' || panel === 'exchange';

  if (isLoading && !data) return <PageLoader />;

  return (
    <div>
      <PageHeader
        title="Sales History"
        subtitle="Click a row to open the invoice — return, exchange, or delete sale records"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!settings) return;
              downloadSalesReportPdf(sales, currency, settings.businessName);
            }}
          >
            Export page PDF
          </Button>
        }
      />

      <DateRangeFilter
        range={range}
        onRangeChange={setRange}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        selectedMonth={selectedMonth}
        onSelectedMonthChange={setSelectedMonth}
        from={dates.from}
        to={dates.to}
      />

      <Card className="mb-4 bg-white" padding="md">
        <Input
          placeholder="Search invoice #, customer, or payment status..."
          value={search}
          autoComplete="off"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Card>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-card)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-surface-muted text-left text-[10px] font-semibold uppercase text-text-muted">
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Cashier</th>
                <th className="px-4 py-3 text-right">Items</th>
                <th className="px-4 py-3">Payment</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Actions</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {sales.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-text-muted">
                    {debouncedSearch
                      ? 'No invoices match your search.'
                      : 'No sales in this date range.'}
                  </td>
                </tr>
              ) : (
                sales.map((s) => (
                  <tr
                    key={s.id}
                    className="cursor-pointer border-b border-border/50 transition hover:bg-brand-50/60"
                    onClick={() => void openInvoice(s.id)}
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-brand-700">{s.saleNumber}</p>
                      {s.hasReturns && (
                        <Badge variant="brand" className="mt-1">
                          Adjusted
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{s.customer?.name ?? 'Walk-in'}</p>
                      {s.customer?.phone && (
                        <p className="text-[10px] text-text-muted">{s.customer.phone}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{s.cashier?.fullName ?? '—'}</td>
                    <td className="px-4 py-3 text-right">{s.itemCount ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={paymentBadgeVariant(s.paymentStatus)}>
                        {paymentLabel(s)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-brand-700">
                      {s.hasReturns && s.netTotal
                        ? formatMoney(s.netTotal, currency)
                        : formatMoney(s.grandTotal, currency)}
                      {s.hasReturns && (
                        <p className="text-[10px] font-normal text-text-muted line-through">
                          {formatMoney(s.grandTotal, currency)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => void openInvoice(s.id)}>
                          View
                        </Button>
                        {canReturn && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void openInvoice(s.id, 'return')}
                          >
                            Return
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-text-muted">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {meta && (
          <div className={`border-t border-border px-4 py-3 ${isFetching ? 'opacity-70' : ''}`}>
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              pageSize={meta.pageSize}
              onPageChange={setPage}
            />
          </div>
        )}
      </div>

      <Modal
        open={!!selected || loadingDetail}
        onClose={closeInvoice}
        title={
          selected
            ? panel === 'return'
              ? `Return — ${selected.saleNumber}`
              : panel === 'exchange'
                ? `Exchange — ${selected.saleNumber}`
                : panel === 'void'
                  ? `Delete — ${selected.saleNumber}`
                  : `Invoice ${selected.saleNumber}`
            : 'Invoice'
        }
        size="xl"
        footer={
          selected ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {panel !== 'receipt' && (
                  <Button variant="ghost" onClick={() => setPanel('receipt')}>
                    Back to invoice
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {panel === 'receipt' && (
                  <>
                    <Button variant="ghost" onClick={closeInvoice}>
                      Close
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => downloadSaleInvoicePdf(selected, currency)}
                    >
                      Download PDF
                    </Button>
                    {canPrint && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (!settings) return;
                          void printSaleReceipt(selected, settings, currency);
                        }}
                      >
                        Reprint
                      </Button>
                    )}
                    {canReturnSelected && (
                      <>
                        <Button onClick={() => openPanel('return')}>Return items</Button>
                        <Button variant="secondary" onClick={() => openPanel('exchange')}>
                          Exchange items
                        </Button>
                      </>
                    )}
                    {canVoid && selected.status === 'COMPLETED' && (
                      <Button variant="danger" onClick={() => openPanel('void')}>
                        Delete sale record
                      </Button>
                    )}
                  </>
                )}
                {isReturnLike && (
                  <>
                    <Button variant="ghost" onClick={() => setPanel('receipt')}>
                      Cancel
                    </Button>
                    <Button
                      disabled={!returnReasonReady || !hasReturnQty}
                      onClick={() => setConfirmReturn(true)}
                    >
                      {panel === 'exchange' ? 'Process exchange' : 'Process return'}
                      {estimatedRefund > 0 ? ` · ${formatMoney(estimatedRefund, currency)}` : ''}
                    </Button>
                  </>
                )}
                {panel === 'void' && (
                  <>
                    <Button variant="ghost" onClick={() => setPanel('receipt')}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={!voidReasonReady}
                      onClick={() => setConfirmVoid(true)}
                    >
                      Confirm delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : undefined
        }
      >
        {loadingDetail || !selected ? (
          <PageLoader />
        ) : isReturnLike ? (
          <div ref={returnPanelRef} className="space-y-4">
            <div
              className={`rounded-xl border p-4 ${
                panel === 'exchange'
                  ? 'border-amber-200 bg-amber-50/80'
                  : 'border-brand-200 bg-brand-50/70'
              }`}
            >
              <p
                className={`font-semibold ${panel === 'exchange' ? 'text-amber-950' : 'text-brand-900'}`}
              >
                {panel === 'exchange'
                  ? 'Exchange items from this invoice'
                  : 'Return items from this invoice'}
              </p>
              <p
                className={`mt-1 text-sm ${panel === 'exchange' ? 'text-amber-900/80' : 'text-brand-800/80'}`}
              >
                {panel === 'exchange'
                  ? 'Select quantities to take back, choose a reason, then continue to the Sale screen to sell the replacement. Stock is restored for tracked products.'
                  : 'Enter qty to return for each line, choose a reason, then process. Stock is restored for tracked products. The original receipt becomes adjusted.'}
              </p>
            </div>

            {selected.returns.length > 0 && (
              <div className="rounded-xl border border-border bg-surface-muted/40 p-3 text-sm">
                <p className="mb-2 font-medium">Already returned on this bill</p>
                {selected.returns.map((ret) => (
                  <p key={ret.id} className="text-xs text-text-muted">
                    {ret.returnNumber}: {formatMoney(ret.totalAmount, currency)} — {ret.reason}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {selected.items.map((item) => {
                const sold = parseFloat(item.quantity);
                const returned = parseFloat(item.returnedQuantity ?? '0');
                const returnable = parseFloat(
                  item.returnableQuantity ?? String(Math.max(0, sold - returned)),
                );
                const unitRefund = sold > 0 ? parseFloat(item.lineTotal) / sold : 0;
                const qty = returnQty[item.id] ?? 0;

                if (returnable <= 0) {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl border border-border bg-surface-muted/30 px-4 py-3 text-sm opacity-60"
                    >
                      <span>{item.productName}</span>
                      <Badge variant="default">Fully returned</Badge>
                    </div>
                  );
                }

                return (
                  <div key={item.id} className="rounded-xl border border-border bg-white px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-text">{item.productName}</p>
                        <p className="mt-1 text-xs text-text-muted">
                          Sold {formatQty(sold)}
                          {returned > 0 ? ` · Already returned ${formatQty(returned)}` : ''} · Can
                          return {formatQty(returnable)} · {formatMoney(unitRefund, currency)} each
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">
                          {panel === 'exchange' ? 'Exchange qty' : 'Return qty'}
                        </span>
                        <Input
                          type="number"
                          min={0}
                          max={returnable}
                          step="1"
                          className="w-24"
                          placeholder="0"
                          value={returnQty[item.id] ?? ''}
                          onChange={(e) => {
                            const next = Number(e.target.value);
                            setReturnQty({
                              ...returnQty,
                              [item.id]: Number.isFinite(next)
                                ? Math.min(Math.max(0, next), returnable)
                                : 0,
                            });
                          }}
                        />
                      </div>
                    </div>
                    {qty > 0 && (
                      <p className="mt-2 text-right text-sm font-semibold text-brand-800">
                        Line credit ≈ {formatMoney(unitRefund * qty, currency)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <ReasonPicker
              label={
                panel === 'exchange' ? 'Exchange reason (required)' : 'Return reason (required)'
              }
              presets={RETURN_REASON_PRESETS}
              value={returnReasonPicker}
              onChange={setReturnReasonPicker}
              customPlaceholder={
                panel === 'exchange'
                  ? 'e.g. Customer wants a different brand'
                  : 'e.g. Customer returned damaged item'
              }
            />

            {estimatedRefund > 0 && (
              <div className="rounded-xl bg-emerald-50 px-4 py-3 text-right">
                <p className="text-xs text-emerald-800">
                  {panel === 'exchange'
                    ? 'Estimated credit toward replacement'
                    : 'Estimated refund'}
                </p>
                <p className="text-2xl font-black text-emerald-900">
                  {formatMoney(estimatedRefund, currency)}
                </p>
              </div>
            )}
          </div>
        ) : panel === 'void' ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
              <p className="font-semibold text-rose-900">Delete sale record</p>
              <p className="mt-1 text-sm text-rose-800">
                Cancels the whole bill ({formatMoney(selected.grandTotal, currency)}), restores
                stock, and reverses udhaar if any. Prefer Return items if only some products came
                back.
              </p>
            </div>
            <ReasonPicker
              label="Delete reason (required)"
              presets={DELETE_SALE_REASON_PRESETS}
              value={voidReasonPicker}
              onChange={setVoidReasonPicker}
              customPlaceholder="Why is this sale record being deleted?"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {selected.returns.length > 0 && (
              <div className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm">
                <p className="font-semibold text-text">Adjusted invoice</p>
                <p className="mt-1 text-text-muted">
                  Original total {formatMoney(selected.grandTotal, currency)} is superseded. Receipt
                  below shows returns and net total.
                </p>
              </div>
            )}
            <ReceiptView sale={selected} currency={currency} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmVoid}
        onClose={() => setConfirmVoid(false)}
        onConfirm={() => voidSale.mutate()}
        title="Delete sale record?"
        message={
          selected ? (
            <>
              Delete sale record <strong className="text-text">{selected.saleNumber}</strong> for{' '}
              {formatMoney(selected.grandTotal, currency)}? Stock will be restored and udhaar
              entries reversed. Reason: {voidReason}
            </>
          ) : null
        }
        confirmLabel="Delete sale record"
        loading={voidSale.isPending}
      />

      <ConfirmDialog
        open={confirmReturn}
        onClose={() => setConfirmReturn(false)}
        onConfirm={() => partialReturn.mutate()}
        title={panel === 'exchange' ? 'Process exchange?' : 'Process return?'}
        message={
          panel === 'exchange' ? (
            <>
              Take back items worth about{' '}
              <strong className="text-text">{formatMoney(estimatedRefund, currency)}</strong>. Stock
              will be restored, then you will open the Sale screen to sell the replacement. Reason:{' '}
              {returnReason}
            </>
          ) : (
            <>
              Refund about{' '}
              <strong className="text-text">{formatMoney(estimatedRefund, currency)}</strong>.
              Selected quantities will return to stock (if tracked). Reason: {returnReason}
            </>
          )
        }
        confirmLabel={panel === 'exchange' ? 'Continue to Sale' : 'Process return'}
        loading={partialReturn.isPending}
      />
    </div>
  );
}
