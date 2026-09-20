import { formatDate, formatMoney, formatQty } from '@/lib/format';
import type { SupplierLedgerEntry } from '@/types/api';

export function PurchaseSlipView({
  entry,
  supplierName,
  currency,
  businessName,
}: {
  entry: SupplierLedgerEntry;
  supplierName: string;
  currency: string;
  businessName: string;
}) {
  const stock = entry.stockIn;

  return (
    <div className="mx-auto max-w-[300px] rounded-lg border border-border bg-white p-4 font-sans text-[11px] leading-normal shadow-sm">
      <div className="border-b-2 border-text pb-2.5 text-center">
        <p className="text-sm font-extrabold uppercase tracking-wide text-text">{businessName}</p>
        <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">
          Purchase / Stock-in Slip
        </p>
      </div>

      <div className="mt-3">
        <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">Details</p>
        <div className="mt-1.5 border-b border-dashed border-border" />
        <div className="mt-2 space-y-1 text-[10px]">
          <div className="flex justify-between gap-3">
            <span className="text-text-muted">Supplier</span>
            <span className="text-right font-semibold">{supplierName}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-text-muted">Date</span>
            <span className="text-right">{formatDate(entry.createdAt)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-text-muted">Type</span>
            <span className="text-right font-medium">{entry.entryType}</span>
          </div>
          {entry.recordedBy && (
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Recorded by</span>
              <span className="text-right">{entry.recordedBy.fullName}</span>
            </div>
          )}
        </div>
      </div>

      {stock && (
        <div className="mt-3">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">
            Items received
          </p>
          <div className="mt-1.5 border-b border-dashed border-border" />
          <p className="mt-2 font-semibold text-text">{stock.productName}</p>
          {stock.sku && <p className="text-[10px] text-text-muted">SKU: {stock.sku}</p>}
          <p className="mt-1 text-[10px]">
            Qty: <strong>{formatQty(stock.quantity)}</strong> {stock.unit}
          </p>
        </div>
      )}

      <div className="mt-3 border-t-2 border-text pt-2">
        <div className="flex justify-between text-sm font-extrabold">
          <span>Payable amount</span>
          <span>{formatMoney(entry.amount, currency)}</span>
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-text-muted">
          <span>Balance after</span>
          <span>{formatMoney(entry.balanceAfter, currency)}</span>
        </div>
      </div>

      {(entry.notes || stock?.notes) && (
        <div className="mt-3">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">Notes</p>
          <div className="mt-1.5 border-b border-dashed border-border" />
          <p className="mt-2 text-[10px] text-text-muted">{entry.notes ?? stock?.notes}</p>
        </div>
      )}
    </div>
  );
}
