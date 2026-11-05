UPDATE "products" SET "target_stock" = 0 WHERE "target_stock" IS NULL;
ALTER TABLE "products" ALTER COLUMN "target_stock" SET DEFAULT 0;
ALTER TABLE "products" ALTER COLUMN "target_stock" SET NOT NULL;