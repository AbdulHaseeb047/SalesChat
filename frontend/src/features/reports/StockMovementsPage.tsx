import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageSkeleton, TableSkeleton } from '@/components/ui/PageSkeleton';
import { QueryError } from '@/components/ui/QueryError';
import { api } from '@/lib/api-client';
import { formatDateShort, formatQty, todayIso } from '@/lib/format';

export function StockMovementsPage() {
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['reports', 'stock-full', from, to],
    queryFn: () => api.reports.stockMovement(from, to, 500),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  if (isError) {
    return (
      <div>
        <PageHeader title="Stock movements" subtitle="Full movement history" />
        <QueryError error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (isLoading && !data) return <PageSkeleton rows={8} />;

  const rows = data?.movements ?? [];

  return (
    <div>
      <PageHeader
        title="Stock movements"
        subtitle={`${rows.length} movement(s) in selected range`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button href="/pos/reports" variant="ghost" size="sm">
              ← Reports
            </Button>
            <Button href="/pos/inventory" variant="secondary" size="sm">
              Inventory
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap gap-3">
          <Input
            label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="max-w-[180px]"
          />
          <Input
            label="To"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="max-w-[180px]"
          />
        </div>
      </Card>

      <Card className={isFetching ? 'opacity-80' : ''}>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            No stock movements in this range.
          </p>
        ) : isFetching && rows.length === 0 ? (
          <TableSkeleton rows={8} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-left text-xs font-semibold uppercase text-text-muted">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Qty change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const delta = Number(m.quantityDelta);
                  const up = Number.isFinite(delta) && delta > 0;
                  return (
                    <tr key={m.id} className="border-b border-border/60">
                      <td className="px-4 py-3 whitespace-nowrap text-text-muted">
                        {formatDateShort(m.createdAt)}
                      </td>
                      <td className="px-4 py-3 font-medium text-text">{m.productName}</td>
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
    </div>
  );
}
