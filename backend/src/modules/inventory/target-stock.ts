type NumericValue = { toString(): string } | number | null | undefined;

/**
 * Money needed to hold the full target stock: current unit cost × target.
 * BATCH targets are counted in batches, so `latestBatchCost` is the cost of one batch.
 * Returns 0 when there is no target, and null when a target is set but its cost is unknown.
 */
export function calculateTargetStockAmount(
  product: {
    trackStock: boolean;
    trackType?: string;
    targetStock: NumericValue;
    costPrice?: NumericValue;
  },
  latestBatchCost?: number | null,
): number | null {
  const target = product.trackStock ? Number(product.targetStock ?? 0) : 0;
  if (!(target > 0)) return 0;

  const cost =
    product.trackType === 'BATCH' ? Number(latestBatchCost ?? 0) : Number(product.costPrice ?? 0);
  return cost > 0 ? target * cost : null;
}
