CREATE TYPE "FinancialEntryType" AS ENUM (
  'INCOME',
  'BUSINESS_EXPENSE',
  'PERSONAL_EXPENSE',
  'HOME_EXPENSE',
  'OWNER_WITHDRAWAL',
  'OWNER_INVESTMENT',
  'REINVESTMENT',
  'REFUND',
  'ADJUSTMENT'
);

CREATE TABLE "financial_entries" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "entry_type" "FinancialEntryType" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "category" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recorded_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_at" TIMESTAMPTZ(6),
  "void_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "financial_entries_tenant_id_occurred_at_idx"
  ON "financial_entries"("tenant_id", "occurred_at");
CREATE INDEX "financial_entries_tenant_id_entry_type_occurred_at_idx"
  ON "financial_entries"("tenant_id", "entry_type", "occurred_at");