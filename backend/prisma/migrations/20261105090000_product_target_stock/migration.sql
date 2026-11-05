ALTER TABLE "products" ADD COLUMN "target_stock" DECIMAL(12,3);

UPDATE "products"
SET "target_stock" = "low_stock_threshold"
WHERE "low_stock_threshold" IS NOT NULL;