import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/Spinner';
import { api } from '@/lib/api-client';
import { useDateRangeFilter } from '@/lib/date-range';
import { FEATURES, hasFeature } from '@/lib/features';
import { useAuth } from '@/lib/auth';
import { formatDateShort, formatMoney, formatQty, todayIso } from '@/lib/format';

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toNumber(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function HorizontalBar({
  label,
  value,
  max,
  color = 'bg-brand-600',
  valueLabel,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
  valueLabel: string;
}) {
  const width = max > 0 ? Math.max(4, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-medium text-text">{label}</span>
        <span className="shrink-0 text-text-muted">{valueLabel}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { user, branchId } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [partFilter, setPartFilter] = useState('');
  const { range, setRange, customFrom, setCustomFrom, customTo, setCustomTo, selectedMonth, setSelectedMonth, dates } =
    useDateRangeFilter('today');

  const canStaffPerf = hasFeature(user, FEATURES.USERS_MANAGE);
  const canShopParts = hasFeature(user, FEATURES.INVENTORY_SHOP_PARTS);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });

  const { data: summary } = useQuery({
    queryKey: ['reports', 'summary', dates.from, dates.to, branchId],
    queryFn: () => api.reports.salesSummary(dates.from, dates.to, branchId ?? undefined),
  });

  const { data: partsSummary } = useQuery({
    queryKey: ['reports', 'shop-parts', dates.from, dates.to, branchId, partFilter],
    queryFn: () =>
      api.reports.shopPartsSummary(
        dates.from,
        dates.to,
        branchId ?? undefined,
        partFilter || undefined,
      ),
    enabled: canShopParts,
  });

  const { data: daily, isLoading } = useQuery({
    queryKey: ['reports', 'daily', date, branchId],
    queryFn: () => api.reports.dailySales(date, branchId ?? undefined),
  });

  const { data: stockMovement } = useQuery({
    queryKey: ['reports', 'stock', dates.from, dates.to],
    queryFn: () => api.reports.stockMovement(dates.from, dates.to, 8),
  });

  const { data: staffPerf } = useQuery({
    queryKey: ['reports', 'staff', dates.from, dates.to],
    queryFn: () => api.reports.staffPerformance(dates.from, dates.to),
    enabled: canStaffPerf,
  });

  const { data: discountUsage } = useQuery({
    queryKey: ['reports', 'discount-usage', dates.from, dates.to],
    queryFn: () => api.discounts.usageReport(dates.from, dates.to),
  });

  const currency = settings?.currency ?? 'PKR';
  const salesVisuals = [
    { label: 'Net revenue', value: toNumber(summary?.revenue), color: 'bg-brand-600' },
    { label: 'Returns', value: toNumber(summary?.returnsAmount), color: 'bg-orange-500' },
    { label: 'Gross Profit', value: toNumber(summary?.grossProfit), color: 'bg-emerald-500' },
    { label: 'COGS', value: toNumber(summary?.cost), color: 'bg-slate-500' },
    { label: 'Tax', value: toNumber(summary?.taxTotal), color: 'bg-sky-500' },
    { label: 'Discount', value: toNumber(summary?.discountTotal), color: 'bg-rose-500' },
  ];
  const maxSalesVisual = Math.max(...salesVisuals.map((v) => v.value), 1);
  const topProducts = summary?.topProducts ?? [];
  const maxTopProductRevenue = Math.max(...topProducts.map((p) => toNumber(p.revenue)), 1);
  const maxDiscountUsage = Math.max(
    ...(discountUsage ?? []).map((r) => toNumber(r.totalDiscount)),
    1,
  );
  const stockPreview = stockMovement?.movements ?? [];

  const exportSummaryCsv = () => {
    downloadCsv(`sales-summary-${dates.from}-${dates.to}.csv`, [
      ['Metric', 'Value'],
      ['From', dates.from],
      ['To', dates.to],
      ['Gross revenue', summary?.grossRevenue ?? '0'],
      ['Returns', summary?.returnsAmount ?? '0'],
      ['Net revenue', summary?.revenue ?? '0'],
      ['Transactions', String(summary?.transactionCount ?? 0)],
      ['Return slips', String(summary?.returnsCount ?? 0)],
      ['Average ticket', summary?.averageTicket ?? '0'],
      ['Discount given', summary?.discountTotal ?? '0'],
      ['Tax collected', summary?.taxTotal ?? '0'],
      ['Cost of goods (COGS)', summary?.cost ?? '0'],
      ['Gross profit', summary?.grossProfit ?? '0'],
    ]);
  };

  if (isLoading) return <PageLoader />;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Sales, stock, and staff analytics"
        action={
          <Button variant="secondary" onClick={exportSummaryCsv}>
            Export CSV
          </Button>
        }
      />

      <Card className="mb-6">
        <CardHeader title="Date range" subtitle="Applies to summary, stock, and staff reports" />
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
          className="mb-0"
        />
      </Card>

      <Card className="mb-6">
        <CardHeader
          title="Sales summary"
          subtitle={`${dates.from} to ${dates.to} · COGS uses cost at sale (batch/product snapshot), not live price`}
        />
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="rounded-xl bg-brand-50 px-4 py-3">
            <p className="text-xs text-text-muted">Net revenue</p>
            <p className="text-xl font-bold">{formatMoney(summary?.revenue ?? '0', currency)}</p>
            <p className="mt-1 text-[10px] text-text-muted">
              Gross {formatMoney(summary?.grossRevenue ?? summary?.revenue ?? '0', currency)} −
              returns
            </p>
          </div>
          <div className="rounded-xl bg-orange-50 px-4 py-3">
            <p className="text-xs text-text-muted">Returns</p>
            <p className="text-xl font-bold text-orange-800">
              {formatMoney(summary?.returnsAmount ?? '0', currency)}
            </p>
            <p className="mt-1 text-[10px] text-text-muted">
              {summary?.returnsCount ?? 0} slip{(summary?.returnsCount ?? 0) === 1 ? '' : 's'}
            </p>
          </div>
          <div className="rounded-xl bg-surface-muted px-4 py-3">
            <p className="text-xs text-text-muted">Transactions</p>
            <p className="text-xl font-bold">{summary?.transactionCount ?? 0}</p>
          </div>
          <div className="rounded-xl bg-surface-muted px-4 py-3">
            <p className="text-xs text-text-muted">Avg ticket</p>
            <p className="text-xl font-bold">
              {formatMoney(summary?.averageTicket ?? '0', currency)}
            </p>
          </div>
          <div className="rounded-xl bg-surface-muted px-4 py-3">
            <p className="text-xs text-text-muted">COGS</p>
            <p className="text-xl font-bold">{formatMoney(summary?.cost ?? '0', currency)}</p>
            <p className="mt-1 text-[10px] text-text-muted">At sale cost</p>
          </div>
          <div className="rounded-xl bg-surface-muted px-4 py-3">
            <p className="text-xs text-text-muted">Gross profit</p>
            <p className="text-xl font-bold">
              {formatMoney(summary?.grossProfit ?? '0', currency)}
            </p>
          </div>
        </div>
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-white p-4">
            <p className="mb-3 text-sm font-semibold">Sales visual summary</p>
            <div className="space-y-3">
              {salesVisuals.map((item) => (
                <HorizontalBar
                  key={item.label}
                  label={item.label}
                  value={item.value}
                  max={maxSalesVisual}
                  color={item.color}
                  valueLabel={formatMoney(item.value, currency)}
                />
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-white p-4">
            <p className="mb-3 text-sm font-semibold">Top products chart</p>
            <div className="space-y-3">
              {topProducts.slice(0, 6).map((p) => (
                <HorizontalBar
                  key={p.productId}
                  label={p.name}
                  value={toNumber(p.revenue)}
                  max={maxTopProductRevenue}
                  valueLabel={formatMoney(p.revenue, currency)}
                />
              ))}
              {topProducts.length === 0 && (
                <p className="py-6 text-center text-sm text-text-muted">
                  No product sales in this range.
                </p>
              )}
            </div>
          </div>
        </div>
        {(summary?.topProducts?.length ?? 0) > 0 && (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                    <th className="px-4 py-3">Top products</th>
                    <th className="px-4 py-3">Qty sold</th>
                    <th className="px-4 py-3">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {summary?.topProducts.map((p) => (
                    <tr key={p.productId} className="border-t border-border/60">
                      <td className="px-4 py-3 font-medium">{p.name}</td>
                      <td className="px-4 py-3">{formatQty(p.quantitySold)}</td>
                      <td className="px-4 py-3 font-semibold">
                        {formatMoney(p.revenue, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {canShopParts && (partsSummary?.parts.length ?? 0) > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="By shop part"
            subtitle="Combined shop total plus each part's revenue, profit, and purchases"
            action={
              <select
                className="rounded-lg border border-border bg-white px-2 py-1.5 text-sm"
                value={partFilter}
                onChange={(e) => setPartFilter(e.target.value)}
              >
                <option value="">All parts</option>
                {partsSummary?.parts.map((part) => (
                  <option key={part.partId ?? 'unassigned'} value={part.partId ?? 'none'}>
                    {part.name}
                  </option>
                ))}
              </select>
            }
          />
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-brand-50 px-4 py-3">
              <p className="text-xs text-text-muted">Combined revenue</p>
              <p className="text-lg font-bold">
                {formatMoney(partsSummary?.combined.revenue ?? '0', currency)}
              </p>
            </div>
            <div className="rounded-xl bg-surface-muted px-4 py-3">
              <p className="text-xs text-text-muted">Combined profit</p>
              <p className="text-lg font-bold">
                {formatMoney(partsSummary?.combined.grossProfit ?? '0', currency)}
              </p>
            </div>
            <div className="rounded-xl bg-surface-muted px-4 py-3">
              <p className="text-xs text-text-muted">Combined COGS</p>
              <p className="text-lg font-bold">
                {formatMoney(partsSummary?.combined.cost ?? '0', currency)}
              </p>
            </div>
            <div className="rounded-xl bg-surface-muted px-4 py-3">
              <p className="text-xs text-text-muted">Combined purchases</p>
              <p className="text-lg font-bold">
                {formatMoney(partsSummary?.combined.purchaseTotal ?? '0', currency)}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                  <th className="px-4 py-3">Part</th>
                  <th className="px-4 py-3">Revenue</th>
                  <th className="px-4 py-3">COGS</th>
                  <th className="px-4 py-3">Profit</th>
                  <th className="px-4 py-3">Purchases</th>
                  <th className="px-4 py-3">Sales</th>
                </tr>
              </thead>
              <tbody>
                {partsSummary?.parts.map((part) => (
                  <tr key={part.partId ?? 'unassigned'} className="border-t border-border/60">
                    <td className="px-4 py-3 font-medium">{part.name}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatMoney(part.revenue, currency)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatMoney(part.cost, currency)}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatMoney(part.grossProfit, currency)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatMoney(part.purchaseTotal, currency)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{part.transactionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(discountUsage?.length ?? 0) > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Discount usage by rule"
            subtitle="Per-rule analytics for the selected period"
          />
          <div className="mb-4 space-y-3 rounded-xl border border-border bg-white p-4">
            {discountUsage?.slice(0, 8).map((row) => (
              <HorizontalBar
                key={row.discountRuleId}
                label={row.ruleName}
                value={toNumber(row.totalDiscount)}
                max={maxDiscountUsage}
                color="bg-rose-500"
                valueLabel={formatMoney(row.totalDiscount, currency)}
              />
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                  <th className="px-4 py-3">Rule</th>
                  <th className="px-4 py-3">Times applied</th>
                  <th className="px-4 py-3">Total discount</th>
                </tr>
              </thead>
              <tbody>
                {discountUsage?.map((row) => (
                  <tr key={row.discountRuleId} className="border-t border-border/60">
                    <td className="px-4 py-3 font-medium">{row.ruleName}</td>
                    <td className="px-4 py-3">{row.usageCount}</td>
                    <td className="px-4 py-3 font-semibold text-danger">
                      {formatMoney(row.totalDiscount, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canStaffPerf && (staffPerf?.length ?? 0) > 0 && (
        <Card className="mb-6">
          <CardHeader title="Staff performance" subtitle="Sales by cashier" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3">Transactions</th>
                  <th className="px-4 py-3">Total sales</th>
                </tr>
              </thead>
              <tbody>
                {staffPerf?.map((s) => (
                  <tr key={s.cashierId} className="border-t border-border/60">
                    <td className="px-4 py-3 font-medium">{s.cashierName}</td>
                    <td className="px-4 py-3">{s.transactionCount}</td>
                    <td className="px-4 py-3 font-semibold">
                      {formatMoney(s.totalSales, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Stock movement"
          subtitle="Recent inventory changes in this range"
          action={
            <Button href="/pos/stock-movements" variant="secondary" size="sm">
              View all
            </Button>
          }
        />
        {stockPreview.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">
            No stock movements in this range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Qty change</th>
                </tr>
              </thead>
              <tbody>
                {stockPreview.map((m) => {
                  const delta = Number(m.quantityDelta);
                  const up = Number.isFinite(delta) && delta > 0;
                  return (
                    <tr key={m.id} className="border-t border-border/60">
                      <td className="px-4 py-3 whitespace-nowrap text-text-muted">
                        {formatDateShort(m.createdAt)}
                      </td>
                      <td className="px-4 py-3 font-medium">{m.productName}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-lg bg-surface-muted px-2 py-1 text-xs font-semibold">
                          {m.movementType.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-semibold ${up ? 'text-emerald-700' : 'text-rose-700'}`}
                      >
                        {up ? '+' : ''}
                        {formatQty(m.quantityDelta)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader title="Daily sales" subtitle="Completed transactions for a date" />
        <div className="mb-4 max-w-xs">
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="mb-4 flex gap-6 rounded-xl bg-brand-50 px-5 py-4">
          <div>
            <p className="text-xs font-medium text-text-muted">Total</p>
            <p className="text-xl font-bold text-brand-800">
              {formatMoney(daily?.total ?? '0', currency)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Transactions</p>
            <p className="text-xl font-bold">{daily?.transactionCount ?? 0}</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                <th className="px-4 py-3">Sale #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {(daily?.sales ?? []).map((s) => (
                <tr key={s.id} className="border-t border-border/60">
                  <td className="px-4 py-3 font-medium">{s.saleNumber}</td>
                  <td className="px-4 py-3 text-text-muted">{s.customerName ?? 'Walk-in'}</td>
                  <td className="px-4 py-3 font-semibold">{formatMoney(s.grandTotal, currency)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatDateShort(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
