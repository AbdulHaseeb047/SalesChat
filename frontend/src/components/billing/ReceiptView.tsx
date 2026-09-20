import { Fragment } from 'react';
import { BRAND } from '@/lib/shared';

import { formatMoney, formatQty } from '@/lib/format';
import type { SaleDetail } from '@/types/api';

function paymentLabel(method: string): string {
  const map: Record<string, string> = {
    CASH: 'Cash',
    CARD: 'Card',
    CREDIT: 'Udhaar (Credit)',
    BANK_TRANSFER: 'Bank Transfer',
    SPLIT: 'Split Payment',
  };
  return map[method] ?? method;
}

function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-PK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

const DEVELOPER = {
  line: BRAND.developer?.line ?? 'System developed by NexMindSystems',
  website: BRAND.developer?.website ?? 'www.NexMindSystems.com',
  websiteUrl: BRAND.developer?.websiteUrl ?? 'https://www.NexMindSystems.com',
  phone: BRAND.developer?.phone ?? '03462734539',
};

function developerFooterHtml(): string {
  return `
  <div class="dev-footer">
    <div class="dev-line">${DEVELOPER.line}</div>
    <div class="dev-row">
      <a class="dev-link" href="${DEVELOPER.websiteUrl}" target="_blank" rel="noopener noreferrer">${DEVELOPER.website}</a>
      <span class="dev-phone">${DEVELOPER.phone}</span>
    </div>
  </div>`;
}

function shopHeaderHtml(r: SaleDetail['receipt']): string {
  const mode = r.receiptHeaderMode ?? 'NAME';
  const hasLogo = !!(r.logoUrl && (mode === 'LOGO' || mode === 'BOTH'));
  const showName = mode === 'NAME' || mode === 'BOTH' || !hasLogo;
  return `
  <div class="shop-header">
    ${hasLogo ? `<img class="shop-logo" src="${r.logoUrl}" alt="${r.businessName}" />` : ''}
    ${showName ? `<div class="shop-name">${r.businessName}</div>` : ''}
    ${r.address ? `<div class="shop-sub">${r.address}</div>` : ''}
    ${r.phone ? `<div class="shop-sub">Tel: ${r.phone}</div>` : ''}
  </div>`;
}

export function buildReceiptHtml(sale: SaleDetail, currency: string): string {
  const r = sale.receipt;
  const dateStr = formatReceiptDate(sale.createdAt);

  const itemRows = sale.items
    .map((i) => {
      const qty = parseFloat(i.quantity);
      const disc = parseFloat(i.discountAmount);
      const discRow =
        disc > 0
          ? `<tr class="disc-row"><td colspan="4" class="disc-cell">↳ Item discount: −${formatMoney(disc, currency)}</td></tr>`
          : '';
      return `
      <tr class="item-row">
        <td class="col-item">${i.productName}</td>
        <td class="col-qty">${formatQty(qty)}</td>
        <td class="col-rate">${formatMoney(i.unitPrice, currency)}</td>
        <td class="col-amt">${formatMoney(i.lineTotal, currency)}</td>
      </tr>${discRow}`;
    })
    .join('');

  const paymentRows = sale.payments
    .map(
      (p) =>
        `<div class="pay-row"><span class="pay-label">${paymentLabel(p.paymentMethod)}</span><span class="pay-val">${formatMoney(p.amount, currency)}</span></div>`,
    )
    .join('');

  const returnedTotal = sale.returns.reduce((sum, ret) => sum + parseFloat(ret.totalAmount), 0);
  const hasReturns = sale.returns.length > 0;
  const netTotal = Math.max(0, parseFloat(sale.grandTotal) - returnedTotal);
  const showChange = sale.changeGiven != null && parseFloat(sale.changeGiven) > 0;
  const isCashSale =
    sale.amountReceived != null &&
    sale.payments.length > 0 &&
    sale.payments.every((p) => p.paymentMethod === 'CASH');

  const returnsBlock = hasReturns
    ? `
  <div class="section adjusted-banner">
    <div class="adjusted-title">ADJUSTED INVOICE</div>
    <div class="adjusted-sub">Original slip superseded — returns applied</div>
  </div>
  <div class="section">
    <div class="section-title">Returns</div>
    <div class="section-rule"></div>
    ${sale.returns
      .map(
        (ret) => `
      <div class="return-block">
        <div class="pay-row"><span class="pay-label">${ret.returnNumber}</span><span class="pay-val">−${formatMoney(ret.totalAmount, currency)}</span></div>
        <div class="return-reason">${ret.reason}</div>
        ${ret.items
          .map(
            (ri) =>
              `<div class="return-item">${ri.productName} × ${formatQty(ri.quantity)} (−${formatMoney(ri.refundAmount, currency)})</div>`,
          )
          .join('')}
      </div>`,
      )
      .join('')}
    <div class="tot-row"><span>Original total</span><span>${formatMoney(sale.grandTotal, currency)}</span></div>
    <div class="tot-row disc"><span>Returned</span><span>−${formatMoney(returnedTotal.toFixed(2), currency)}</span></div>
    <div class="tot-row grand"><span>NET TOTAL</span><span>${formatMoney(netTotal.toFixed(2), currency)}</span></div>
  </div>`
    : '';

  const paymentBlock = `
  <div class="section">
    <div class="section-title">Payment</div>
    <div class="section-rule"></div>
    ${
      isCashSale
        ? `<div class="pay-row"><span class="pay-label">Cash from customer</span><span class="pay-val">${formatMoney(sale.amountReceived!, currency)}</span></div>
           <div class="pay-row"><span class="pay-label">Bill total</span><span class="pay-val">${formatMoney(sale.grandTotal, currency)}</span></div>
           ${showChange ? `<div class="tender-change"><span>Change back</span><span>${formatMoney(sale.changeGiven!, currency)}</span></div>` : ''}`
        : `${paymentRows}
           ${
             sale.amountReceived != null
               ? `<div class="pay-row"><span class="pay-label">Cash tendered</span><span class="pay-val">${formatMoney(sale.amountReceived, currency)}</span></div>
                  ${showChange ? `<div class="tender-change"><span>Change back</span><span>${formatMoney(sale.changeGiven!, currency)}</span></div>` : ''}`
               : ''
           }`
    }
  </div>`;

  const fbrBlock =
    r.fbrEnabled && sale.fbrInvoiceNumber
      ? `
  <div class="section fbr">
    <div class="section-title">FBR Integrated Invoice</div>
    <div class="section-rule"></div>
    ${r.fbrRegisteredName ? `<div class="fbr-line">${r.fbrRegisteredName}</div>` : ''}
    ${r.fbrStrn ? `<div class="fbr-line">STRN / NTN: <strong>${r.fbrStrn}</strong></div>` : ''}
    ${r.fbrPosId ? `<div class="fbr-line">POS ID: <strong>${r.fbrPosId}</strong></div>` : ''}
    <div class="fbr-line">FBR Invoice #: <strong>${sale.fbrInvoiceNumber}</strong></div>
    ${sale.fbrQrData ? `<div class="qr-box">[ FBR QR CODE ]</div>` : ''}
  </div>`
      : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt ${sale.saleNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1a1a1a; width: 80mm; max-width: 80mm; margin: 0 auto; padding: 10px 8px; line-height: 1.45; }
    .shop-header { text-align: center; padding-bottom: 10px; border-bottom: 2px solid #1a1a1a; }
    .shop-logo { display: block; max-width: 140px; max-height: 56px; width: auto; height: auto; margin: 0 auto 8px; object-fit: contain; }
    .shop-name { font-size: 15px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; }
    .shop-sub { font-size: 9px; color: #555; margin-top: 3px; }
    .section { margin: 10px 0 0; }
    .section-title { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: #888; line-height: 1.3; }
    .section-rule { border-bottom: 1px dashed #ccc; margin: 4px 0 8px; height: 0; }
    .section-body { padding-top: 0; }
    .meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font-size: 10px; }
    .meta-label { color: #666; }
    .meta-val { font-weight: 600; text-align: right; }
    table.items { width: 100%; border-collapse: collapse; font-size: 10px; }
    table.items th { font-size: 8px; text-transform: uppercase; letter-spacing: 0.1em; color: #888; border-bottom: 1px solid #333; padding: 3px 0 5px; text-align: left; }
    table.items th.col-qty, table.items th.col-rate, table.items th.col-amt { text-align: right; }
    table.items td { padding: 5px 0; vertical-align: top; border-bottom: 1px dotted #ddd; }
    .col-item { width: 42%; }
    .col-qty { width: 12%; text-align: right; }
    .col-rate { width: 22%; text-align: right; }
    .col-amt { width: 24%; text-align: right; font-weight: 600; }
    .disc-row td { padding: 0 0 3px 8px !important; border: none !important; }
    .disc-cell { font-size: 9px; color: #c00; }
    .totals { font-size: 10px; }
    .tot-row { display: flex; justify-content: space-between; padding: 4px 0; line-height: 1.4; }
    .tot-row.disc { color: #c00; }
    .tot-row.grand { font-size: 14px; font-weight: 800; border-top: 2px solid #1a1a1a; margin-top: 6px; padding-top: 8px; }
    .pay-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; line-height: 1.4; }
    .pay-label { color: #555; }
    .pay-val { font-weight: 600; }
    .tender-received { display: flex; justify-content: space-between; padding: 4px 0 10px; line-height: 1.4; font-size: 10px; }
    .tender-change { display: flex; justify-content: space-between; margin-top: 4px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 13px; font-weight: 800; color: #047857; line-height: 1.4; }
    .adjusted-banner { border: 1.5px solid #1a1a1a; padding: 8px; text-align: center; background: #f4f4f5; }
    .adjusted-title { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; }
    .adjusted-sub { font-size: 9px; color: #555; margin-top: 2px; }
    .return-block { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px dotted #ddd; }
    .return-reason { font-size: 9px; color: #666; margin: 2px 0 4px; }
    .return-item { font-size: 9px; color: #444; padding: 1px 0; }
    .fbr { border: 2px solid #1a1a1a; padding: 8px; text-align: center; }
    .fbr-line { font-size: 9px; margin: 2px 0; }
    .qr-box { margin: 6px auto; width: 56px; height: 56px; border: 1px solid #333; display: flex; align-items: center; justify-content: center; font-size: 7px; color: #666; }
    .footer { text-align: center; margin-top: 12px; padding-top: 10px; border-top: 1px dashed #ccc; font-size: 9px; color: #666; }
    .shop-footer { font-size: 9px; color: #555; margin-bottom: 6px; white-space: pre-wrap; }
    .thank { font-size: 11px; font-weight: 700; color: #1a1a1a; margin: 6px 0 8px; }
    .dev-footer { margin-top: 8px; padding-top: 6px; border-top: 1px solid #e5e5e5; text-align: left; }
    .dev-line { font-size: 8px; color: #888; margin-bottom: 3px; text-align: center; }
    .dev-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 8px; color: #666; }
    .dev-link { color: #555; text-decoration: none; }
    .dev-phone { font-weight: 600; white-space: nowrap; }
  </style>
</head>
<body>
  ${shopHeaderHtml(r)}

  <div class="section">
    <div class="section-title">Invoice Details</div>
    <div class="section-rule"></div>
    <div class="meta-grid">
      <span class="meta-label">Invoice #</span><span class="meta-val">${sale.saleNumber}</span>
      <span class="meta-label">Date & Time</span><span class="meta-val">${dateStr}</span>
      <span class="meta-label">Customer</span><span class="meta-val">${sale.customer?.name ?? 'Walk-in'}</span>
      <span class="meta-label">Cashier</span><span class="meta-val">${sale.cashier.fullName}</span>
      ${sale.customer?.phone ? `<span class="meta-label">Phone</span><span class="meta-val">${sale.customer.phone}</span>` : ''}
    </div>
  </div>

  ${fbrBlock}

  <div class="section">
    <div class="section-title">Items (${sale.items.length})</div>
    <div class="section-rule"></div>
    <table class="items">
      <thead>
        <tr>
          <th class="col-item">Description</th>
          <th class="col-qty">Qty</th>
          <th class="col-rate">Rate</th>
          <th class="col-amt">Amount</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Payment Summary</div>
    <div class="section-rule"></div>
    <div class="totals">
      <div class="tot-row"><span>Subtotal</span><span>${formatMoney(sale.subtotal, currency)}</span></div>
      ${parseFloat(sale.discountTotal) > 0 ? `<div class="tot-row disc"><span>Total Discount</span><span>−${formatMoney(sale.discountTotal, currency)}</span></div>` : ''}
      ${parseFloat(sale.taxTotal) > 0 ? `<div class="tot-row"><span>${r.taxLabel}</span><span>${formatMoney(sale.taxTotal, currency)}</span></div>` : ''}
      <div class="tot-row grand"><span>${hasReturns ? 'ORIGINAL TOTAL' : 'GRAND TOTAL'}</span><span>${formatMoney(sale.grandTotal, currency)}</span></div>
    </div>
  </div>

  ${returnsBlock}
  ${paymentBlock}

  ${sale.notes ? `<div class="section"><div class="section-title">Notes</div><div class="section-rule"></div><div style="font-size:10px;color:#555">${sale.notes}</div></div>` : ''}

  <div class="footer">
    ${r.receiptFooter ? `<div class="shop-footer">${r.receiptFooter}</div>` : ''}
    <div class="thank">شکریہ — Thank you for your business!</div>
    ${developerFooterHtml()}
  </div>
</body>
</html>`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] leading-tight text-text-muted">
        {children}
      </p>
      <div className="mt-1.5 border-b border-dashed border-border" />
    </div>
  );
}

function DeveloperFooter() {
  return (
    <div className="mt-2 border-t border-border/60 pt-2 text-left">
      <p className="text-center text-[8px] text-text-muted">{DEVELOPER.line}</p>
      <div className="mt-1 flex items-center justify-between gap-2 text-[8px] text-text-muted">
        <a
          href={DEVELOPER.websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          {DEVELOPER.website}
        </a>
        <span className="shrink-0 font-semibold">{DEVELOPER.phone}</span>
      </div>
    </div>
  );
}

function ShopHeader({ receipt }: { receipt: SaleDetail['receipt'] }) {
  const mode = receipt.receiptHeaderMode ?? 'NAME';
  const hasLogo = !!(receipt.logoUrl && (mode === 'LOGO' || mode === 'BOTH'));
  const showName = mode === 'NAME' || mode === 'BOTH' || !hasLogo;

  return (
    <div className="border-b-2 border-text pb-2.5 text-center">
      {hasLogo && (
        <img
          src={receipt.logoUrl!}
          alt={receipt.businessName}
          className="mx-auto mb-2 max-h-14 max-w-[140px] object-contain"
        />
      )}
      {showName && (
        <p className="text-sm font-extrabold uppercase tracking-wide text-text">
          {receipt.businessName}
        </p>
      )}
      {receipt.address && <p className="mt-1 text-[9px] text-text-muted">{receipt.address}</p>}
      {receipt.phone && <p className="mt-0.5 text-[9px] text-text-muted">Tel: {receipt.phone}</p>}
    </div>
  );
}

export function ReceiptView({ sale, currency }: { sale: SaleDetail; currency: string }) {
  const r = sale.receipt;
  const showChange = sale.changeGiven != null && parseFloat(sale.changeGiven) > 0;
  const returnedTotal = sale.returns.reduce((sum, ret) => sum + parseFloat(ret.totalAmount), 0);
  const hasReturns = sale.returns.length > 0;
  const netTotal = Math.max(0, parseFloat(sale.grandTotal) - returnedTotal);
  const isCashSale =
    sale.amountReceived != null &&
    sale.payments.length > 0 &&
    sale.payments.every((p) => p.paymentMethod === 'CASH');

  return (
    <div className="mx-auto max-w-[300px] rounded-lg border border-border bg-white p-4 font-sans text-[11px] leading-normal shadow-sm">
      <ShopHeader receipt={r} />

      <div className="mt-3">
        <SectionTitle>Invoice Details</SectionTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
          <dt className="text-text-muted">Invoice #</dt>
          <dd className="text-right font-semibold">{sale.saleNumber}</dd>
          <dt className="text-text-muted">Date</dt>
          <dd className="text-right">{formatReceiptDate(sale.createdAt)}</dd>
          <dt className="text-text-muted">Customer</dt>
          <dd className="text-right font-medium">{sale.customer?.name ?? 'Walk-in'}</dd>
          <dt className="text-text-muted">Cashier</dt>
          <dd className="text-right">{sale.cashier.fullName}</dd>
        </dl>
      </div>

      {r.fbrEnabled && sale.fbrInvoiceNumber && (
        <div className="mt-3 border-2 border-text p-2 text-center text-[9px]">
          <p className="text-[10px] font-extrabold uppercase">FBR Integrated Invoice</p>
          {r.fbrRegisteredName && <p className="mt-1">{r.fbrRegisteredName}</p>}
          {r.fbrStrn && (
            <p>
              STRN/NTN: <strong>{r.fbrStrn}</strong>
            </p>
          )}
          {r.fbrPosId && (
            <p>
              POS ID: <strong>{r.fbrPosId}</strong>
            </p>
          )}
          <p className="mt-1 font-bold">#{sale.fbrInvoiceNumber}</p>
        </div>
      )}

      <div className="mt-3">
        <SectionTitle>Items ({sale.items.length})</SectionTitle>
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-text/30 text-[8px] uppercase text-text-muted">
              <th className="pb-1.5 text-left font-semibold">Item</th>
              <th className="pb-1.5 text-right font-semibold">Qty</th>
              <th className="pb-1.5 text-right font-semibold">Rate</th>
              <th className="pb-1.5 text-right font-semibold">Amt</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <Fragment key={item.id}>
                <tr className="border-b border-border/30">
                  <td className="py-1.5 pr-1 leading-tight">{item.productName}</td>
                  <td className="py-1.5 text-right">{formatQty(item.quantity)}</td>
                  <td className="py-1.5 text-right text-text-muted">
                    {formatMoney(item.unitPrice, currency)}
                  </td>
                  <td className="py-1.5 text-right font-semibold">
                    {formatMoney(item.lineTotal, currency)}
                  </td>
                </tr>
                {parseFloat(item.discountAmount) > 0 && (
                  <tr className="text-[9px] text-danger">
                    <td colSpan={4} className="pb-1 pl-2">
                      ↳ Discount: −{formatMoney(item.discountAmount, currency)}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <SectionTitle>Payment Summary</SectionTitle>
        <div className="space-y-1 text-[10px]">
          <div className="flex justify-between py-0.5">
            <span className="text-text-muted">Subtotal</span>
            <span>{formatMoney(sale.subtotal, currency)}</span>
          </div>
          {parseFloat(sale.discountTotal) > 0 && (
            <div className="flex justify-between py-0.5 text-danger">
              <span>Discount</span>
              <span>−{formatMoney(sale.discountTotal, currency)}</span>
            </div>
          )}
          {parseFloat(sale.taxTotal) > 0 && (
            <div className="flex justify-between py-0.5">
              <span className="text-text-muted">{r.taxLabel}</span>
              <span>{formatMoney(sale.taxTotal, currency)}</span>
            </div>
          )}
          <div className="mt-1.5 flex justify-between border-t-2 border-text pt-2 text-sm font-extrabold">
            <span>{hasReturns ? 'ORIGINAL TOTAL' : 'GRAND TOTAL'}</span>
            <span>{formatMoney(sale.grandTotal, currency)}</span>
          </div>
        </div>
      </div>

      {hasReturns && (
        <>
          <div className="mt-3 border border-text bg-surface-muted px-3 py-2 text-center">
            <p className="text-[11px] font-extrabold tracking-wide">ADJUSTED INVOICE</p>
            <p className="mt-0.5 text-[9px] text-text-muted">
              Original slip superseded — returns applied
            </p>
          </div>
          <div className="mt-3">
            <SectionTitle>Returns</SectionTitle>
            <div className="space-y-2 text-[10px]">
              {sale.returns.map((ret) => (
                <div key={ret.id} className="border-b border-dotted border-border pb-2">
                  <div className="flex justify-between">
                    <span className="text-text-muted">{ret.returnNumber}</span>
                    <span className="font-semibold text-danger">
                      −{formatMoney(ret.totalAmount, currency)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[9px] text-text-muted">{ret.reason}</p>
                  {ret.items.map((ri) => (
                    <p key={ri.id} className="text-[9px] text-text-muted">
                      {ri.productName} × {formatQty(ri.quantity)} (−
                      {formatMoney(ri.refundAmount, currency)})
                    </p>
                  ))}
                </div>
              ))}
              <div className="flex justify-between py-0.5">
                <span className="text-text-muted">Original total</span>
                <span>{formatMoney(sale.grandTotal, currency)}</span>
              </div>
              <div className="flex justify-between py-0.5 text-danger">
                <span>Returned</span>
                <span>−{formatMoney(returnedTotal.toFixed(2), currency)}</span>
              </div>
              <div className="flex justify-between border-t-2 border-text pt-2 text-sm font-extrabold">
                <span>NET TOTAL</span>
                <span>{formatMoney(netTotal.toFixed(2), currency)}</span>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-3">
        <SectionTitle>Payment</SectionTitle>
        <div className="space-y-1 text-[10px]">
          {isCashSale ? (
            <>
              <div className="flex justify-between py-0.5">
                <span className="text-text-muted">Cash from customer</span>
                <span className="font-semibold">{formatMoney(sale.amountReceived!, currency)}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-text-muted">Bill total</span>
                <span className="font-semibold">{formatMoney(sale.grandTotal, currency)}</span>
              </div>
              {showChange && (
                <div className="flex justify-between border-t border-border pt-2.5 text-sm font-extrabold leading-normal text-emerald-700">
                  <span>Change back</span>
                  <span>{formatMoney(sale.changeGiven!, currency)}</span>
                </div>
              )}
            </>
          ) : (
            <>
              {sale.payments.map((p) => (
                <div key={p.id} className="flex justify-between py-0.5">
                  <span className="text-text-muted">{paymentLabel(p.paymentMethod)}</span>
                  <span className="font-semibold">{formatMoney(p.amount, currency)}</span>
                </div>
              ))}
              {sale.amountReceived != null && (
                <>
                  <div className="flex justify-between py-0.5">
                    <span className="text-text-muted">Cash tendered</span>
                    <span className="font-semibold">
                      {formatMoney(sale.amountReceived, currency)}
                    </span>
                  </div>
                  {showChange && (
                    <div className="flex justify-between border-t border-border pt-2.5 text-sm font-extrabold leading-normal text-emerald-700">
                      <span>Change back</span>
                      <span>{formatMoney(sale.changeGiven!, currency)}</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {sale.notes && (
        <div className="mt-3">
          <SectionTitle>Notes</SectionTitle>
          <p className="text-[10px] text-text-muted">{sale.notes}</p>
        </div>
      )}

      <div className="mt-4 border-t border-dashed border-border pt-2.5 text-center">
        {r.receiptFooter && (
          <p className="mb-2 whitespace-pre-wrap text-[9px] text-text-muted">{r.receiptFooter}</p>
        )}
        <p className="text-xs font-bold">شکریہ — Thank you!</p>
        <DeveloperFooter />
      </div>
    </div>
  );
}

export function printReceipt(sale: SaleDetail, currency: string): void {
  const w = window.open('', '_blank', 'width=400,height=700');
  if (!w) return;
  w.document.write(buildReceiptHtml(sale, currency));
  w.document.close();
  w.focus();
  w.print();
}
