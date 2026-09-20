import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useMemo, useState, type ReactNode } from 'react';

import type { DashboardSummary, DashboardWidgetId } from '@/types/api';

type KpiMetric = {
  id: string;
  label: string;
  value: number;
  changePct: number;
  format: 'currency' | 'number';
};

const CATEGORY_PAGE_SIZE = 5;

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatUnits(value: number) {
  return value.toLocaleString('en-PK', {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

function KpiCard({
  metric,
  currency,
  compareLabel,
}: {
  metric: KpiMetric;
  currency: string;
  compareLabel: string;
}) {
  const up = metric.changePct >= 0;
  const display =
    metric.format === 'currency'
      ? formatMoney(metric.value, currency)
      : metric.value.toLocaleString('en-PK');

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{metric.label}</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
        <p className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{display}</p>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
            up ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {up ? '↑' : '↓'} {Math.abs(metric.changePct).toFixed(1)}%
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400">{compareLabel}</p>
    </div>
  );
}

function HourlyTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: { revenue: number; transactions: number } }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{label}</p>
      <p className="mt-1 text-emerald-700">Revenue: {formatMoney(row.revenue, currency)}</p>
      <p className="text-slate-600">Transactions: {row.transactions}</p>
    </div>
  );
}

function MoneyTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; name?: string }>;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{payload[0].name}</p>
      <p className="mt-1 text-emerald-700">
        {formatMoney(Number(payload[0].value ?? 0), currency)}
      </p>
    </div>
  );
}

function UnitsTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; name?: string; payload?: { revenue?: number } }>;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0];
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{row.name}</p>
      <p className="mt-1 text-emerald-700">Units sold: {formatUnits(Number(row.value ?? 0))}</p>
      {row.payload?.revenue != null && (
        <p className="text-slate-600">Revenue: {formatMoney(row.payload.revenue, currency)}</p>
      )}
    </div>
  );
}

const DEFAULT_CHART_ORDER: DashboardWidgetId[] = [
  'kpis',
  'trend',
  'payments',
  'topProducts',
  'topCategories',
];

export function SalesDashboard({
  data,
  currency = 'PKR',
  visibleIds,
}: {
  data: DashboardSummary;
  currency?: string;
  /** When set, only render these chart widgets (order preserved). */
  visibleIds?: DashboardWidgetId[];
}) {
  const [categoryPage, setCategoryPage] = useState(0);

  const order = (visibleIds ?? DEFAULT_CHART_ORDER).filter((id) =>
    DEFAULT_CHART_ORDER.includes(id),
  );

  const kpis: KpiMetric[] = [
    {
      id: 'revenue',
      label: 'Total Revenue',
      value: Number(data.todaySalesTotal) || 0,
      changePct: data.revenueChangePct ?? 0,
      format: 'currency',
    },
    {
      id: 'aov',
      label: 'Average Order Value',
      value: Number(data.averageOrderValue ?? 0) || 0,
      changePct: data.aovChangePct ?? 0,
      format: 'currency',
    },
    {
      id: 'transactions',
      label: 'Total Transactions',
      value: data.todayTransactionCount ?? 0,
      changePct: data.transactionChangePct ?? 0,
      format: 'number',
    },
  ];

  const hourlySales = data.hourlySales ?? [];
  const paymentMethods = data.paymentMethods ?? [];
  const topProducts = data.topProducts ?? [];
  const topCategories = data.topCategories ?? [];
  const paymentTotal = paymentMethods.reduce((s, p) => s + p.value, 0);
  const hasHourly = hourlySales.some((h) => h.revenue > 0 || h.transactions > 0);
  const compareLabel = data.compareLabel ?? 'vs prior period';
  const isHourly = (data.chartMode ?? 'hourly') === 'hourly';

  const categoryPageCount = Math.max(1, Math.ceil(topCategories.length / CATEGORY_PAGE_SIZE));
  const safeCategoryPage = Math.min(categoryPage, categoryPageCount - 1);
  const pagedCategories = useMemo(() => {
    const start = safeCategoryPage * CATEGORY_PAGE_SIZE;
    return topCategories.slice(start, start + CATEGORY_PAGE_SIZE);
  }, [safeCategoryPage, topCategories]);

  const kpisNode = (
    <div key="kpis" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {kpis.map((kpi) => (
        <KpiCard key={kpi.id} metric={kpi} currency={currency} compareLabel={compareLabel} />
      ))}
    </div>
  );

  const trendNode = (
    <div key="trend" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-900">
          {isHourly ? 'Hourly sales trend' : 'Daily sales trend'}
        </h3>
        <p className="text-sm text-slate-500">
          {isHourly
            ? 'Revenue across store hours (8:00 AM – 10:00 PM)'
            : `Revenue by day (${data.from ?? ''} – ${data.to ?? ''})`}
        </p>
      </div>
      <div className="h-64 w-full sm:h-72">
        {!hasHourly ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            No sales recorded in this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={hourlySales} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="hourlyRevenueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#059669" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#059669" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="hour"
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={48}
                tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
              />
              <Tooltip
                content={<HourlyTooltip currency={currency} />}
                cursor={{ stroke: '#94a3b8', strokeDasharray: '4 4' }}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                name="Revenue"
                stroke="#059669"
                strokeWidth={2}
                fill="url(#hourlyRevenueFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );

  const paymentsNode = (
    <div
      key="payments"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-900">Payment methods</h3>
        <p className="text-sm text-slate-500">Share of collected payments in this period</p>
      </div>
      {paymentTotal <= 0 ? (
        <div className="flex h-64 items-center justify-center text-sm text-slate-500 sm:h-72">
          No payments in this period
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="mx-auto h-52 w-full max-w-[220px] sm:mx-0 sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={paymentMethods}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                >
                  {paymentMethods.map((item) => (
                    <Cell key={item.name} fill={item.color} />
                  ))}
                </Pie>
                <Tooltip content={<MoneyTooltip currency={currency} />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex-1 space-y-2">
            {paymentMethods.map((item) => {
              const amount = item.amount != null ? Number(item.amount) : null;
              return (
                <li key={item.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 text-slate-700">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    {item.name}
                  </span>
                  <span className="shrink-0 font-medium text-slate-900">
                    {item.value.toFixed(1)}%
                    {amount != null && !Number.isNaN(amount) ? (
                      <span className="ml-2 font-normal text-slate-500">
                        {formatMoney(amount, currency)}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );

  const topProductsNode = (
    <div
      key="topProducts"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-900">Top selling products</h3>
        <p className="text-sm text-slate-500">Top 5 items by units sold in this period</p>
      </div>
      <div className="h-64 w-full sm:h-72">
        {topProducts.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            No product sales in this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={topProducts}
              margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={{ fill: '#334155', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={<UnitsTooltip currency={currency} />}
                cursor={{ fill: '#f1f5f9' }}
              />
              <Bar dataKey="quantitySold" name="Units sold" radius={[0, 8, 8, 0]} barSize={18}>
                {topProducts.map((item) => (
                  <Cell key={item.name} fill="#059669" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );

  const topCategoriesNode = (
    <div
      key="topCategories"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Best selling categories</h3>
          <p className="text-sm text-slate-500">Ranked by units sold in this period</p>
        </div>
        {topCategories.length > CATEGORY_PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
              disabled={safeCategoryPage <= 0}
              onClick={() => setCategoryPage((p) => Math.max(0, p - 1))}
            >
              Prev
            </button>
            <span className="text-xs text-slate-500">
              {safeCategoryPage + 1} / {categoryPageCount}
            </span>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
              disabled={safeCategoryPage >= categoryPageCount - 1}
              onClick={() => setCategoryPage((p) => Math.min(categoryPageCount - 1, p + 1))}
            >
              Next
            </button>
          </div>
        )}
      </div>
      {topCategories.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-slate-500">
          No category sales in this period
        </div>
      ) : (
        <ul className="space-y-2">
          {pagedCategories.map((cat, index) => {
            const rank = safeCategoryPage * CATEGORY_PAGE_SIZE + index + 1;
            return (
              <li
                key={cat.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    <span className="mr-2 text-slate-400">#{rank}</span>
                    {cat.name}
                  </p>
                  <p className="text-xs text-slate-500">{formatMoney(cat.revenue, currency)}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-emerald-700">
                  {formatUnits(cat.quantitySold)} sold
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const byId: Record<string, ReactNode> = {
    kpis: kpisNode,
    trend: trendNode,
    payments: paymentsNode,
    topProducts: topProductsNode,
    topCategories: topCategoriesNode,
  };

  const nodes: ReactNode[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const next = order[i + 1];
    // Keep top products + categories side-by-side when adjacent.
    if (
      (id === 'topProducts' && next === 'topCategories') ||
      (id === 'topCategories' && next === 'topProducts')
    ) {
      nodes.push(
        <div key={`${id}-${next}`} className="grid gap-4 lg:grid-cols-2">
          {byId[id]}
          {byId[next!]}
        </div>,
      );
      i += 1;
      continue;
    }
    // Keep payments + top products side-by-side when adjacent (and categories not next).
    if (
      (id === 'payments' && next === 'topProducts' && order[i + 2] !== 'topCategories') ||
      (id === 'topProducts' && next === 'payments')
    ) {
      nodes.push(
        <div key={`${id}-${next}`} className="grid gap-4 lg:grid-cols-2">
          {byId[id]}
          {byId[next!]}
        </div>,
      );
      i += 1;
      continue;
    }
    if (byId[id]) nodes.push(byId[id]);
  }

  return <div className="space-y-4">{nodes}</div>;
}
