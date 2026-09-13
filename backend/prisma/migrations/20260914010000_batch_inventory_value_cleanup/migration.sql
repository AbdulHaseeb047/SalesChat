-- Batch product inventory value is remaining × cost_per_unit on WAREHOUSE/OPEN batches.
-- Clear stale SIMPLE cost_price left after track-type conversion (was inflating totals).
-- Resync stock_quantity from active batches so it stays consistent (do not wipe real batch stock).

UPDATE products
SET
  cost_price = NULL,
  updated_at = NOW()
WHERE track_type = 'BATCH'
  AND deleted_at IS NULL
  AND cost_price IS NOT NULL;

UPDATE products p
SET
  stock_quantity = COALESCE((
    SELECT SUM(b.remaining_quantity)
    FROM batches b
    WHERE b.product_id = p.id
      AND b.status IN ('WAREHOUSE', 'OPEN')
  ), 0),
  updated_at = NOW()
WHERE p.track_type = 'BATCH'
  AND p.deleted_at IS NULL;
