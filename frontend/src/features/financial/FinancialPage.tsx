'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api-client';
import { useDateRangeFilter } from '@/lib/date-range';
import { formatDate, formatMoney, todayIso } from '@/lib/format';
import type { FinancialSummary } from '@/types/api';

const RECORD_TYPES = [
  { value: 'BUSINESS_EXPENSE', label: 'Shop expense (rent, bill, petrol)', flow: 'out' },
  { value: 'OWNER_WITHDRAWAL', label: 'I took money home', flow: 'out' },
  { value: 'HOME_EXPENSE', label: 'Home expense from shop cash', flow: 'out' },
  { value: 'PERSONAL_EXPENSE', label: 'Personal expense from shop cash', flow: 'out' },
  { value: 'INVENTORY_PURCHASE', label: 'I paid cash for stock', flow: 'out' },
  { value: 'REFUND', label: 'Gave a customer refund', flow: 'out' },
  { value: 'OWNER_INVESTMENT', label: 'I put my own money into the shop', flow: 'in' },
  { value: 'INCOME', label: 'Extra money in (not from a sale)', flow: 'in' },
] as const;

function money(summary: FinancialSummary | undefined, key: keyof FinancialSummary, fallback?: string) {
  const value = summary?.[key] ?? fallback ?? '0';
  return typeof value === 'string' ? value : '0';
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <div>
        <p className="text-text">{label}</p>
        {hint ? <p className="text-[11px] text-text-muted">{hint}</p> : null}
      </div>
      <p className="shrink-0 font-semibold tabular-nums">{formatMoney(value, 'PKR')}</p>
    </div>
  );
}

export function FinancialPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const {
    range,
    setRange,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    selectedMonth,
    setSelectedMonth,
    dates,
  } = useDateRangeFilter('month');
  const [form, setForm] = useState({
    entryType: 'BUSINESS_EXPENSE',
    amount: '',
    category: '',
    description: '',
    occurredAt: todayIso(),
  });

  const { data: entries, isLoading } = useQuery({
    queryKey: ['financial', 'entries', dates.from, dates.to],
    queryFn: () => api.financial.entries(dates.from, dates.to),
  });
  const { data: summary } = useQuery({
    queryKey: ['financial', 'summary', dates.from, dates.to],
    queryFn: () => api.financial.summary(dates.from, dates.to),
  });

  const create = useMutation({
    mutationFn: () =>
      api.financial.create({
        entryType: form.entryType,
        amount: Number(form.amount),
        category: form.category.trim() || undefined,
        description: form.description.trim() || undefined,
        occurredAt: new Date(`${form.occurredAt}T12:00:00.000Z`).toISOString(),
      }),
    onSuccess: () => {
      setForm({ ...form, amount: '', category: '', description: '' });
      void queryClient.invalidateQueries({ queryKey: ['financial'] });
      toast.success('Record saved');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not save record'),
  });

  const selectedType = RECORD_TYPES.find((t) => t.value === form.entryType);
  const moneyIn = money(summary, 'moneyIn', summary?.inflows);
  const moneyOut = money(summary, 'moneyOut', summary?.outflows);
  const cashLeft = money(summary, 'cashLeft', summary?.netMovement);
  const stockBought = money(summary, 'stockBought', summary?.purchasesRecorded);
  const stillOwe = money(summary, 'stillOweSuppliers', '0');
  const cashOutIsZero = Number(moneyOut) === 0;
  const stockIsLarge = Number(stockBought) > 0;

  const labelFor = (type: string) =>
    type === 'STOCK_IN'
      ? 'Stock received (not cash yet)'
      : RECORD_TYPES.find((t) => t.value === type)?.label ?? type;

  return (
    <div>
      <PageHeader
        title="Shop cash"
        subtitle="Simple view of money in, money out, and stock you received."
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

      <div className="mb-6 grid gap-3 lg:grid-cols-3">
        <Card>
          <p className="text-xs font-medium text-text-muted">Money that came in</p>
          <p className="mt-1 text-2xl font-bold text-emerald-700">{formatMoney(moneyIn, 'PKR')}</p>
          <p className="mt-1 text-[11px] text-text-muted">Cash from sales, udhaar collections, and money you put in</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-text-muted">Money that went out</p>
          <p className="mt-1 text-2xl font-bold text-rose-700">{formatMoney(moneyOut, 'PKR')}</p>
          <p className="mt-1 text-[11px] text-text-muted">Cash paid to suppliers, shop bills, and money you took out</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-text-muted">Cash left from this period</p>
          <p className="mt-1 text-2xl font-bold">{formatMoney(cashLeft, 'PKR')}</p>
          <p className="mt-1 text-[11px] text-text-muted">Money in minus money out. This is not your bank balance.</p>
        </Card>
      </div>

      {cashOutIsZero && stockIsLarge ? (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Stock of {formatMoney(stockBought, 'PKR')} came into the shop, but no cash payment is recorded
          yet. Buying stock on credit does not reduce cash until you pay the supplier or add an expense
          below. Estimated still unpaid to suppliers: {formatMoney(stillOwe, 'PKR')}.
        </div>
      ) : null}

      <div className="mb-6 grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader title="Where money came from" subtitle="Cash into the shop" />
          <Row label="Sales collected" value={money(summary, 'salesCollected')} hint="Cash / card bills, not udhaar sales" />
          <Row label="Udhaar collected" value={money(summary, 'customerCollections')} hint="Old customer dues paid" />
          <Row label="Owner put money in" value={money(summary, 'ownerPutIn', '0')} />
          <Row label="Other income" value={money(summary, 'otherIncome', '0')} />
        </Card>
        <Card>
          <CardHeader title="Where money went" subtitle="Cash out of the shop" />
          <Row label="Paid to suppliers" value={money(summary, 'supplierPayments')} hint="Recorded supplier payments" />
          <Row label="Shop / home expenses" value={money(summary, 'shopExpenses', '0')} hint="Add bills below, e.g. electricity" />
          <Row label="Owner took money" value={money(summary, 'ownerTookOut', '0')} />
          <Row label="Paid cash for stock" value={money(summary, 'cashStockPurchases', '0')} />
          <Row label="Refunds" value={money(summary, 'refunds', '0')} />
        </Card>
        <Card>
          <CardHeader title="Stock (not cash)" subtitle="Goods received vs paid" />
          <Row
            label="Stock received"
            value={stockBought}
            hint="Inventory that arrived. This is goods, not cash leaving."
          />
          <Row label="Already paid to suppliers" value={money(summary, 'supplierPayments')} />
          <Row
            label="Still unpaid (estimate)"
            value={stillOwe}
            hint="Stock received minus supplier payments"
          />
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader
          title="Add a cash record"
          subtitle="Use this only for money that is not already in Sales or Supplier payments. Example: electricity bill, petrol, or money taken home."
        />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Select
            label="What happened?"
            value={form.entryType}
            onChange={(e) => setForm({ ...form, entryType: e.target.value })}
            options={RECORD_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
          <Input
            label="Amount"
            type="number"
            min="0"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="0"
          />
          <Input
            label="Date"
            type="date"
            value={form.occurredAt}
            onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
          />
          <div className="flex items-end">
            <Button
              className="w-full"
              loading={create.isPending}
              disabled={!form.amount || Number(form.amount) <= 0}
              onClick={() => create.mutate()}
            >
              Save
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Input
            label="Short name (optional)"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            placeholder={selectedType?.flow === 'out' ? 'e.g. electricity, rent' : 'e.g. extra cash'}
          />
          <Input
            label="Note (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Who was paid, bill number, etc."
          />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          {selectedType?.flow === 'in'
            ? 'This will increase Money that came in.'
            : 'This will increase Money that went out.'}{' '}
          Sales and supplier payments are added automatically — do not enter them again here.
        </p>
      </Card>

      <Card>
        <CardHeader title="Records" subtitle={`${dates.from} to ${dates.to}`} />
        {isLoading ? (
          <p className="py-8 text-center text-sm text-text-muted">Loading records…</p>
        ) : (entries ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            No extra cash records in this period. Sales and stock received still appear in the summary
            above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs uppercase text-text-muted">
                  <th className="px-3 py-3">Date</th>
                  <th className="px-3 py-3">What happened</th>
                  <th className="px-3 py-3">Detail</th>
                  <th className="px-3 py-3">Note</th>
                  <th className="px-3 py-3 text-right">Amount</th>
                  <th className="px-3 py-3">Type</th>
                </tr>
              </thead>
              <tbody>
                {entries?.map((entry) => {
                  const flow = entry.flow ?? (entry.entryType === 'STOCK_IN' ? 'stock' : 'other');
                  const tone =
                    flow === 'in' ? 'text-emerald-700' : flow === 'out' ? 'text-rose-700' : 'text-text';
                  const badge =
                    flow === 'in' ? 'Money in' : flow === 'out' ? 'Money out' : 'Stock, not cash';
                  return (
                    <tr key={entry.id} className="border-t border-border/60">
                      <td className="px-3 py-3">{formatDate(entry.occurredAt)}</td>
                      <td className="px-3 py-3">{labelFor(entry.entryType)}</td>
                      <td className="px-3 py-3">{entry.category}</td>
                      <td className="px-3 py-3 text-text-muted">{entry.description || '—'}</td>
                      <td className={`px-3 py-3 text-right font-semibold tabular-nums ${tone}`}>
                        {flow === 'out' ? '−' : flow === 'in' ? '+' : ''}
                        {formatMoney(entry.amount, 'PKR')}
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant={entry.voidedAt ? 'danger' : flow === 'out' ? 'warning' : 'success'}>
                          {entry.voidedAt ? 'Voided' : badge}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
