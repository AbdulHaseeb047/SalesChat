import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { formatProductStock, getStockStatus } from '@/lib/sale-utils';

export function ProductListPanel({
  title,
  subtitle,
  categoryId,
  partId,
  brandId,
  currency,
  onClose,
}: {
  title: string;
  subtitle?: string;
  categoryId?: string;
  partId?: string;
  brandId?: string;
  currency: string;
  onClose?: () => void;
}) {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['products', 'catalog-panel', categoryId ?? 'all', partId ?? 'all', brandId ?? 'all'],
    queryFn: () =>
      api.products.list({
        categoryId: categoryId || undefined,
        partId: partId || undefined,
        brandId: brandId || undefined,
        pageSize: 200,
      }),
    enabled: !!(categoryId || partId || brandId),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const products = data?.data ?? [];

  return (
    <Card className="h-full">
      <CardHeader
        title={title}
        subtitle={subtitle ?? `${products.length} products`}
        action={
          onClose ? (
            <button
              type="button"
              className="text-xs font-medium text-text-muted hover:text-text"
              onClick={onClose}
            >
              Close
            </button>
          ) : undefined
        }
      />
      {isLoading || (isFetching && !data) ? (
        <PageSkeleton rows={5} />
      ) : products.length === 0 ? (
        <p className="py-12 text-center text-sm text-text-muted">No products linked yet.</p>
      ) : (
        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-left text-[10px] font-semibold uppercase text-text-muted">
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Stock</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const status = getStockStatus(p);
                return (
                  <tr key={p.id} className="border-b border-border/50">
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-text">{p.name}</p>
                      {p.category?.name && (
                        <p className="text-[10px] text-text-muted">{p.category.name}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-text-muted">{p.sku ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-brand-700">
                      {formatMoney(p.sellPrice, currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {p.trackStock ? (
                        <Badge
                          variant={
                            status === 'low' ? 'warning' : status === 'out' ? 'danger' : 'default'
                          }
                        >
                          {formatProductStock(p)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
