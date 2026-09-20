import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { PurchaseSlipView } from '@/components/billing/PurchaseSlipView';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/Spinner';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, formatQty, formatDecimalInput } from '@/lib/format';
import type { Supplier, SupplierLedgerEntry } from '@/types/api';

export function SuppliersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [stockModal, setStockModal] = useState<Supplier | null>(null);
  const [paymentModal, setPaymentModal] = useState<Supplier | null>(null);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', notes: '' });
  const [stockForm, setStockForm] = useState({
    productId: '',
    quantity: '',
    costPrice: '',
    recordPayable: true,
    notes: '',
  });
  const [paymentForm, setPaymentForm] = useState({ amount: '', notes: '' });
  const [slipEntry, setSlipEntry] = useState<SupplierLedgerEntry | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.suppliers.list(),
  });

  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ['supplier-ledger', selected?.id],
    queryFn: () => api.suppliers.ledger(selected!.id),
    enabled: !!selected,
  });

  const { data: products } = useQuery({
    queryKey: ['products', 'suppliers'],
    queryFn: () => api.products.list({ pageSize: 200 }),
    enabled: !!stockModal,
  });

  const currency = settings?.currency ?? 'PKR';

  const save = useMutation({
    mutationFn: () =>
      editing ? api.suppliers.update(editing.id, form) : api.suppliers.create(form),
    onSuccess: () => {
      setModal(false);
      setEditing(null);
      setForm({ name: '', phone: '', email: '', address: '', notes: '' });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not save supplier');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.suppliers.delete(id),
    onSuccess: () => {
      setSelected(null);
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });

  const stockIn = useMutation({
    mutationFn: () =>
      api.suppliers.stockIn(stockModal!.id, {
        productId: stockForm.productId,
        quantity: parseFloat(stockForm.quantity),
        costPrice: stockForm.costPrice ? parseFloat(stockForm.costPrice) : undefined,
        recordPayable: stockForm.recordPayable,
        notes: stockForm.notes || undefined,
      }),
    onSuccess: (updated) => {
      setStockModal(null);
      setStockForm({ productId: '', quantity: '', costPrice: '', recordPayable: true, notes: '' });
      if (selected?.id === updated.id) setSelected(updated);
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['supplier-ledger', updated.id] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const recordPayment = useMutation({
    mutationFn: () =>
      api.suppliers.payment(paymentModal!.id, {
        amount: parseFloat(paymentForm.amount),
        paymentMethod: 'cash',
        notes: paymentForm.notes || undefined,
      }),
    onSuccess: (updated) => {
      setPaymentModal(null);
      setPaymentForm({ amount: '', notes: '' });
      if (updated) {
        setSelected(updated);
        void queryClient.invalidateQueries({ queryKey: ['supplier-ledger', updated.id] });
      }
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });

  const supplierProducts = (products?.data ?? []).filter((p) => p.supplier?.id === stockModal?.id);

  if (isLoading) return <PageLoader />;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className={`lg:col-span-2 ${selected ? 'hidden lg:block' : ''}`}>
        <PageHeader
          title="Suppliers"
          subtitle="All vendors — select to view purchases, payables & slips"
          action={
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setForm({ name: '', phone: '', email: '', address: '', notes: '' });
                setModal(true);
              }}
            >
              Add supplier
            </Button>
          }
        />
        <div className="max-h-[calc(100vh-14rem)] space-y-2 overflow-y-auto">
          {(data ?? []).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s)}
              className={`w-full rounded-xl border p-4 text-left transition ${
                selected?.id === s.id
                  ? 'border-brand-400 bg-brand-50'
                  : 'border-border bg-surface hover:border-brand-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-xs text-text-muted">{s.phone ?? 'No phone'}</p>
                </div>
                {parseFloat(s.balance) > 0 && (
                  <Badge variant="warning">Payable {formatMoney(s.balance, currency)}</Badge>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className={`lg:col-span-3 ${!selected ? 'hidden lg:block' : ''}`}>
        {!selected ? (
          <Card className="flex h-64 items-center justify-center text-text-muted">
            Select a supplier to view payable ledger
          </Card>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="mb-3 lg:hidden"
              onClick={() => setSelected(null)}
            >
              ← Back to suppliers
            </Button>{' '}
            <Card className="mb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">{selected.name}</h2>
                  <p className="text-sm text-text-muted">
                    {selected.phone} {selected.email && `· ${selected.email}`}
                  </p>
                  {selected.address && (
                    <p className="text-sm text-text-muted">{selected.address}</p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-xs text-text-muted">Outstanding payable</p>
                  <p className="text-3xl font-black text-brand-700">
                    {formatMoney(selected.balance, currency)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="accent" onClick={() => setStockModal(selected)}>
                  Stock-in
                </Button>
                {parseFloat(selected.balance) > 0 && (
                  <Button size="sm" onClick={() => setPaymentModal(selected)}>
                    Record payment
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing(selected);
                    setForm({
                      name: selected.name,
                      phone: selected.phone ?? '',
                      email: selected.email ?? '',
                      address: selected.address ?? '',
                      notes: selected.notes ?? '',
                    });
                    setModal(true);
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleteTarget(selected)}>
                  Delete
                </Button>
              </div>
              <SupplierProductList supplierId={selected.id} currency={currency} />
            </Card>
            <Card>
              <CardHeader
                title="Purchase & payment log"
                subtitle="Click a stock-in row to view the purchase slip"
              />
              {ledgerLoading ? (
                <PageLoader />
              ) : (
                <div className="overflow-hidden rounded-xl border border-border">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="bg-surface-muted text-left text-[10px] font-semibold uppercase text-text-muted">
                          <th className="px-4 py-3">Date</th>
                          <th className="px-4 py-3">Description</th>
                          <th className="px-4 py-3 text-right">Amount</th>
                          <th className="px-4 py-3 text-right">Balance</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {(ledger ?? []).map((e) => (
                          <tr
                            key={e.id}
                            className={`border-t border-border/60 ${e.stockIn ? 'cursor-pointer hover:bg-brand-50/50' : ''}`}
                            onClick={() => e.stockIn && setSlipEntry(e)}
                          >
                            <td className="px-4 py-3 text-text-muted">{formatDate(e.createdAt)}</td>
                            <td className="px-4 py-3">
                              <p className="font-medium">{e.description}</p>
                              {e.stockIn && (
                                <p className="text-[10px] text-text-muted">
                                  {formatQty(e.stockIn.quantity)} {e.stockIn.unit}
                                  {e.stockIn.sku ? ` · ${e.stockIn.sku}` : ''}
                                </p>
                              )}
                              {e.recordedBy && (
                                <p className="text-[10px] text-text-muted">
                                  By {e.recordedBy.fullName}
                                </p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold">
                              {formatMoney(e.amount, currency)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {formatMoney(e.balanceAfter, currency)}
                            </td>
                            <td
                              className="px-4 py-3 text-right"
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              {e.stockIn && (
                                <button
                                  type="button"
                                  className="text-xs font-medium text-brand-700 hover:underline"
                                  onClick={() => setSlipEntry(e)}
                                >
                                  Slip
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                        {(ledger ?? []).length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-text-muted">
                              No ledger entries yet — record a stock-in with cost to create payable
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <Modal
        open={!!slipEntry}
        onClose={() => setSlipEntry(null)}
        title="Purchase slip"
        size="lg"
        footer={<Button onClick={() => setSlipEntry(null)}>Close</Button>}
      >
        {slipEntry && selected && (
          <PurchaseSlipView
            entry={slipEntry}
            supplierName={selected.name}
            currency={currency}
            businessName={settings?.businessName ?? 'POS'}
          />
        )}
      </Modal>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit supplier' : 'New supplier'}
        footer={
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        }
      >
        <div className="space-y-3">
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            label="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <Input
            label="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input
            label="Address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <Input
            label="Notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={!!stockModal}
        onClose={() => setStockModal(null)}
        title={`Stock-in — ${stockModal?.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStockModal(null)}>
              Cancel
            </Button>
            <Button loading={stockIn.isPending} onClick={() => stockIn.mutate()}>
              Record stock-in
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="Product"
            value={stockForm.productId}
            onChange={(e) => {
              const p = (products?.data ?? []).find((x) => x.id === e.target.value);
              setStockForm({
                ...stockForm,
                productId: e.target.value,
                costPrice: formatDecimalInput(p?.costPrice),
              });
            }}
            options={[
              { value: '', label: 'Select product...' },
              ...(supplierProducts.length > 0
                ? supplierProducts.map((p) => ({ value: p.id, label: `${p.name} (mapped)` }))
                : (products?.data ?? []).map((p) => ({ value: p.id, label: p.name }))),
            ]}
          />
          <Input
            label="Quantity"
            type="number"
            min={0}
            value={stockForm.quantity}
            onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })}
          />
          <Input
            label="Cost price (per unit)"
            type="number"
            min={0}
            value={stockForm.costPrice}
            onChange={(e) => setStockForm({ ...stockForm, costPrice: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={stockForm.recordPayable}
              onChange={(e) => setStockForm({ ...stockForm, recordPayable: e.target.checked })}
            />
            Record payable to supplier (qty × cost)
          </label>
          <Input
            label="Notes"
            value={stockForm.notes}
            onChange={(e) => setStockForm({ ...stockForm, notes: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={!!paymentModal}
        onClose={() => setPaymentModal(null)}
        title={`Pay supplier — ${paymentModal?.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPaymentModal(null)}>
              Cancel
            </Button>
            <Button loading={recordPayment.isPending} onClick={() => recordPayment.mutate()}>
              Record payment
            </Button>
          </>
        }
      >
        <Input
          label="Amount"
          type="number"
          value={paymentForm.amount}
          onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
        />
        <Input
          className="mt-3"
          label="Notes"
          value={paymentForm.notes}
          onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
        />
      </Modal>

      <ConfirmDialog
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
        title="Delete supplier"
        message={
          deleteTarget ? (
            <>
              Delete supplier <strong className="text-text">{deleteTarget.name}</strong>? Purchase
              history will remain but the supplier will be removed from active lists.
            </>
          ) : null
        }
        confirmLabel="Delete supplier"
        loading={remove.isPending}
      />
    </div>
  );
}

function SupplierProductList({ supplierId, currency }: { supplierId: string; currency: string }) {
  const { data: products } = useQuery({
    queryKey: ['products', 'by-supplier', supplierId],
    queryFn: () => api.products.list({ pageSize: 100 }),
  });
  const mapped = (products?.data ?? []).filter((p) => p.supplier?.id === supplierId);
  if (mapped.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="mb-2 text-xs font-semibold uppercase text-text-muted">Mapped products</p>
      <div className="flex flex-wrap gap-2">
        {mapped.map((p) => (
          <Badge key={p.id} variant="default">
            {p.name} · {formatMoney(p.sellPrice, currency)}
          </Badge>
        ))}
      </div>
    </div>
  );
}
