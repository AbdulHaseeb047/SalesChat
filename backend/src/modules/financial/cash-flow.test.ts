import { describe, expect, it } from 'vitest';

import { cashFlowForType, summarizeCashBuckets } from './cash-flow.js';

describe('cashFlowForType', () => {
  it('treats sales-related owner records as cash in or out', () => {
    expect(cashFlowForType('INCOME')).toBe('in');
    expect(cashFlowForType('OWNER_INVESTMENT')).toBe('in');
    expect(cashFlowForType('BUSINESS_EXPENSE')).toBe('out');
    expect(cashFlowForType('OWNER_WITHDRAWAL')).toBe('out');
    expect(cashFlowForType('STOCK_IN')).toBe('stock');
  });
});

describe('summarizeCashBuckets', () => {
  it('does not treat unpaid stock purchases as cash leaving the shop', () => {
    const result = summarizeCashBuckets({
      byType: new Map(),
      salesCollected: 508464.9,
      customerCollections: 31290,
      supplierPayments: 0,
      stockBought: 978626,
    });
    expect(result.moneyIn).toBe(539754.9);
    expect(result.moneyOut).toBe(0);
    expect(result.cashLeft).toBe(539754.9);
    expect(result.stockBought).toBe(978626);
    expect(result.stillOweSuppliers).toBe(978626);
  });

  it('counts recorded expenses and supplier payments as money out', () => {
    const result = summarizeCashBuckets({
      byType: new Map([
        ['BUSINESS_EXPENSE', 5000],
        ['OWNER_WITHDRAWAL', 2000],
      ]),
      salesCollected: 10000,
      customerCollections: 0,
      supplierPayments: 3000,
      stockBought: 8000,
    });
    expect(result.moneyOut).toBe(10000);
    expect(result.cashLeft).toBe(0);
    expect(result.stillOweSuppliers).toBe(5000);
  });
});
