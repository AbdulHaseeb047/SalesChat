/**
 * Audit: for every BATCH product, product.stock_quantity must equal
 * sum(batches.remaining_quantity) where status IN (WAREHOUSE, OPEN).
 *
 * Run: npx tsx scripts/audit-batch-stock-sync.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null, trackType: 'BATCH', trackStock: true },
    select: {
      id: true,
      name: true,
      stockQuantity: true,
      tenantId: true,
      batches: {
        where: { status: { in: ['WAREHOUSE', 'OPEN'] } },
        select: { id: true, status: true, remainingQuantity: true },
      },
    },
  });

  const mismatches: Array<{
    name: string;
    productStock: string;
    batchSum: string;
    delta: string;
    warehouse: number;
    open: number;
  }> = [];

  let ok = 0;
  for (const p of products) {
    const batchSum = p.batches.reduce(
      (s, b) => s.plus(b.remainingQuantity),
      new Decimal(0),
    );
    const delta = p.stockQuantity.minus(batchSum);
    if (delta.abs().gt(0.001)) {
      mismatches.push({
        name: p.name,
        productStock: p.stockQuantity.toFixed(3),
        batchSum: batchSum.toFixed(3),
        delta: delta.toFixed(3),
        warehouse: p.batches.filter((b) => b.status === 'WAREHOUSE').length,
        open: p.batches.filter((b) => b.status === 'OPEN').length,
      });
    } else {
      ok += 1;
    }
  }

  console.log(`Checked ${products.length} batch products`);
  console.log(`In sync: ${ok}`);
  console.log(`Out of sync: ${mismatches.length}`);
  if (mismatches.length > 0) {
    console.log('\nMismatches (product stock − Σ batch remaining):');
    for (const m of mismatches) {
      console.log(
        `  • ${m.name}: product=${m.productStock} batches=${m.batchSum} delta=${m.delta} (WH:${m.warehouse} OPEN:${m.open})`,
      );
    }
    console.log(
      '\nPositive delta = system product qty HIGHER than coils (overstates inventory).',
    );
    console.log('Negative delta = product qty LOWER than coils.');
    process.exitCode = 1;
  } else {
    console.log('\nAll batch products: product.stock_quantity == Σ batch remaining. ✓');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
