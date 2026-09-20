'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@/lib/next-nav';

import { IconSale } from '@/components/icons';
import { Card } from '@/components/ui/Card';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { MonthSelectDropdown } from '@/components/ui/MonthSelectDropdown';
import { ListSkeleton } from '@/components/ui/PageSkeleton';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonShimmer } from '@/components/ui/Skeleton';
import { DashboardLayoutCustomizeModal } from '@/features/dashboard/DashboardLayoutCustomizeModal';
import { SalesDashboard } from '@/features/dashboard/SalesDashboard';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { resolveDashboardLayout } from '@/lib/dashboard-layout';
import { useDateRangeFilter } from '@/lib/date-range';
import { FEATURES, hasFeature } from '@/lib/features';
import { formatMoney, formatQty } from '@/lib/format';
import type { DashboardWidgetId } from '@/types/api';

const CHART_IDS: DashboardWidgetId[] = [
  'kpis',
  'trend',
  'payments',
  'topProducts',
  'topCategories',
];

export function DashboardPage() {
  const { user, branchId } = useAuth();
  const { range, setRange, customFrom, setCustomFrom, customTo, setCustomTo, selectedMonth, setSelectedMonth, dates } =
    useDateRangeFilter('today');
  const canCustomize = hasFeature(user, FEATURES.UI_CUSTOMIZE);
  const canShopParts = hasFeature(user, FEATURES.INVENTORY_SHOP_PARTS);
  const [showLayoutCustomize, setShowLayoutCustomize] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 5 * 60_000,
  });

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', branchId, dates.from, dates.to],
    queryFn: () => api.reports.dashboard(branchId ?? undefined, dates.from, dates.to),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const { data: partsSummary } = useQuery({
    queryKey: ['reports', 'shop-parts', 'dashboard', dates.from, dates.to, branchId],
    queryFn: () =>
      api.reports.shopPartsSummary(dates.from, dates.to, branchId ?? undefined),
    enabled: canShopParts && hasFeature(user, FEATURES.REPORTS_VIEW),
    staleTime: 60_000,
  });

  const layout = useMemo(
    () => resolveDashboardLayout(canCustomize ? settings?.dashboardLayout : null),
    [canCustomize, settings?.dashboardLayout],
  );
  const visibleWidgets = useMemo(
    () => layout.widgets.filter((w) => w.visible).map((w) => w.id),
    [layout],
  );

  if (isError) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Your business overview" />
        <QueryError error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const currency = settings?.currency ?? 'PKR';
  const lowStockCount = data?.lowStockCount ?? data?.lowStockAlerts?.length ?? 0;
  const lowStockPreview = (data?.lowStockAlerts ?? []).slice(0, 5);
  const showLoading = isLoading || (isFetching && !data);
  const shopParts = partsSummary?.parts ?? [];
  // Equal-width fill of the section; wrap after 6 per row.
  const shopPartCols = Math.min(Math.max(shopParts.length, 1), 6);
  const shopPartsGridClass =
    shopPartCols <= 1
      ? 'grid-cols-1'
      : shopPartCols === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : shopPartCols === 3
          ? 'grid-cols-1 sm:grid-cols-3'
          : shopPartCols === 4
            ? 'grid-cols-2 lg:grid-cols-4'
            : shopPartCols === 5
              ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5'
              : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6';

  const returnsCard = (
    <Card key="returns">
      <div className="mb-3">
        <h3 className="text-base font-bold text-text">Returns in period</h3>
        <p className="text-sm text-text-muted">Refunds for the selected date range</p>
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-surface-muted/60 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Amount returned
          </p>
          <p className="mt-1 text-2xl font-bold text-brand-800">
            {formatMoney(data?.todayReturnsAmount ?? '0', currency)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border px-4 py-3">
            <p className="text-xs text-text-muted">Return slips</p>
            <p className="mt-1 text-xl font-bold text-text">{data?.todayReturnsCount ?? 0}</p>
          </div>
          <div className="rounded-xl border border-border px-4 py-3">
            <p className="text-xs text-text-muted">Units returned</p>
            <p className="mt-1 text-xl font-bold text-text">
              {Number(data?.todayReturnedUnits ?? 0).toLocaleString('en-PK', {
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
        </div>
        {hasFeature(user, FEATURES.BILLING_CREATE_SALE) && (
          <Link
            to="/pos/sales"
            className="inline-flex text-sm font-semibold text-brand-700 hover:underline"
          >
            Open sales history →
          </Link>
        )}
      </div>
    </Card>
  );

  const lowStockCard = (
    <Card key="lowStock">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-text">Low stock alerts</h3>
          <p className="text-sm text-text-muted">Top 5 below threshold</p>
        </div>
        {lowStockCount > 0 && hasFeature(user, FEATURES.INVENTORY_VIEW) && (
          <Link
            to="/pos/inventory?stock=low"
            className="shrink-0 rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-800 hover:bg-brand-100"
          >
            View all
          </Link>
        )}
      </div>
      {showLoading ? (
        <ListSkeleton rows={5} />
      ) : lowStockPreview.length === 0 ? (
        <p className="text-sm text-text-muted">All stock levels look good.</p>
      ) : (
        <ul className="space-y-2">
          {lowStockPreview.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 font-medium text-text">{item.name}</span>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <span className="rounded-lg bg-amber-100 px-2.5 py-1 font-semibold text-amber-900">
                  Present {formatQty(item.stockQuantity)}
                </span>
                <span className="rounded-lg bg-white px-2.5 py-1 font-medium text-text-muted ring-1 ring-border">
                  Alert at {formatQty(item.lowStockThreshold)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const chartsSkeleton = (
    <div className="space-y-4" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid gap-4 sm:grid-cols-3">
        <SkeletonShimmer className="h-28 rounded-xl" />
        <SkeletonShimmer className="h-28 rounded-xl" />
        <SkeletonShimmer className="h-28 rounded-xl" />
      </div>
      <SkeletonShimmer className="h-72 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonShimmer className="h-64 rounded-xl" />
        <SkeletonShimmer className="h-64 rounded-xl" />
      </div>
    </div>
  );

  // Render in saved order. Consecutive chart widgets share one bordered panel;
  // consecutive returns/lowStock share a 2-col grid.
  const bodyNodes: ReactNode[] = [];
  let i = 0;
  while (i < visibleWidgets.length) {
    const id = visibleWidgets[i]!;
    if (CHART_IDS.includes(id)) {
      const chartRun: DashboardWidgetId[] = [];
      while (i < visibleWidgets.length && CHART_IDS.includes(visibleWidgets[i]!)) {
        chartRun.push(visibleWidgets[i]!);
        i++;
      }
      bodyNodes.push(
        <div
          key={`charts-${chartRun.join('-')}`}
          className="mt-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-6"
        >
          {showLoading || !data ? (
            chartsSkeleton
          ) : (
            <div className={isFetching ? 'opacity-80 transition-opacity' : ''}>
              <SalesDashboard data={data} currency={currency} visibleIds={chartRun} />
            </div>
          )}
        </div>,
      );
      continue;
    }

    const cardRun: DashboardWidgetId[] = [];
    while (
      i < visibleWidgets.length &&
      (visibleWidgets[i] === 'returns' || visibleWidgets[i] === 'lowStock')
    ) {
      cardRun.push(visibleWidgets[i]!);
      i++;
    }
    bodyNodes.push(
      <div
        key={`cards-${cardRun.join('-')}`}
        className={`mt-6 grid gap-6 ${cardRun.length > 1 ? 'lg:grid-cols-2' : ''}`}
      >
        {cardRun.map((cid) => (cid === 'returns' ? returnsCard : lowStockCard))}
      </div>,
    );
  }

  return (
    <div>
      <PageHeader
        title={`Hello, ${user?.fullName?.split(' ')[0] ?? 'there'}`}
        subtitle={settings?.businessName ?? 'Your business overview'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <MonthSelectDropdown
              variant="header"
              range={range}
              selectedMonth={selectedMonth}
              onSelectMonth={setSelectedMonth}
              onRangeChange={setRange}
            />
            {canCustomize && (
              <button
                type="button"
                onClick={() => setShowLayoutCustomize(true)}
                className="inline-flex min-h-[44px] items-center rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-semibold text-text hover:bg-surface-muted"
              >
                Customize layout
              </button>
            )}
            {hasFeature(user, FEATURES.BILLING_CREATE_SALE) ? (
              <Link to="/pos/sale">
                <span className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700">
                  <IconSale className="h-4 w-4" />
                  New sale
                </span>
              </Link>
            ) : null}
          </div>
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

      {canShopParts && shopParts.length > 0 && (
        <Card className="mt-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-text">Shop parts</h2>
              <p className="text-xs text-text-muted">Revenue by part for the selected period</p>
            </div>
            <Link
              to="/pos/shop-parts"
              className="text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              Manage parts
            </Link>
          </div>
          <div className={`grid gap-3 ${shopPartsGridClass}`}>
            {shopParts.map((part) => (
              <div
                key={part.partId ?? 'unassigned'}
                className="min-w-0 rounded-xl border border-border bg-surface-muted/60 px-4 py-4"
              >
                <p className="truncate text-sm font-semibold text-text">{part.name}</p>
                <p className="mt-1 text-lg font-bold tabular-nums sm:text-xl">
                  {formatMoney(part.revenue, currency)}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  Profit {formatMoney(part.grossProfit, currency)}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="space-y-0">{bodyNodes}</div>

      {visibleWidgets.length === 0 && (
        <p className="mt-6 text-sm text-text-muted">
          All dashboard sections are hidden. Use Customize layout to show some again.
        </p>
      )}

      <DashboardLayoutCustomizeModal
        open={showLayoutCustomize}
        onClose={() => setShowLayoutCustomize(false)}
        initial={settings?.dashboardLayout}
      />
    </div>
  );
}
