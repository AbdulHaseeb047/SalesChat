export const financialEntryTypes = [
  'INCOME',
  'INVENTORY_PURCHASE',
  'BUSINESS_EXPENSE',
  'PERSONAL_EXPENSE',
  'HOME_EXPENSE',
  'OWNER_WITHDRAWAL',
  'OWNER_INVESTMENT',
  'REINVESTMENT',
  'REFUND',
  'ADJUSTMENT',
] as const;

/** Cash that entered the shop drawer. */
export const CASH_IN_TYPES = new Set(['INCOME', 'OWNER_INVESTMENT']);

/** Cash that left the shop drawer. */
export const CASH_OUT_TYPES = new Set([
  'BUSINESS_EXPENSE',
  'PERSONAL_EXPENSE',
  'HOME_EXPENSE',
  'OWNER_WITHDRAWAL',
  'REFUND',
  'INVENTORY_PURCHASE',
]);

export type CashFlow = 'in' | 'out' | 'stock' | 'other';

export function cashFlowForType(entryType: string): CashFlow {
  if (entryType === 'STOCK_IN') return 'stock';
  if (CASH_IN_TYPES.has(entryType)) return 'in';
  if (CASH_OUT_TYPES.has(entryType)) return 'out';
  return 'other';
}

export function defaultCategoryForType(entryType: string): string {
  switch (entryType) {
    case 'INCOME':
      return 'Other income';
    case 'OWNER_INVESTMENT':
      return 'Owner put money in';
    case 'BUSINESS_EXPENSE':
      return 'Shop expense';
    case 'PERSONAL_EXPENSE':
      return 'Personal expense';
    case 'HOME_EXPENSE':
      return 'Home expense';
    case 'OWNER_WITHDRAWAL':
      return 'Owner took money';
    case 'INVENTORY_PURCHASE':
      return 'Paid for stock';
    case 'REFUND':
      return 'Refund';
    case 'REINVESTMENT':
      return 'Reinvestment';
    default:
      return 'Other';
  }
}

export function summarizeCashBuckets(params: {
  byType: Map<string, number>;
  salesCollected: number;
  customerCollections: number;
  supplierPayments: number;
  stockBought: number;
}) {
  const typeTotal = (type: string) => params.byType.get(type) ?? 0;
  const ownerPutIn = typeTotal('OWNER_INVESTMENT');
  const otherIncome = typeTotal('INCOME');
  const shopExpenses =
    typeTotal('BUSINESS_EXPENSE') + typeTotal('PERSONAL_EXPENSE') + typeTotal('HOME_EXPENSE');
  const ownerTookOut = typeTotal('OWNER_WITHDRAWAL');
  const refunds = typeTotal('REFUND');
  const cashStockPurchases = typeTotal('INVENTORY_PURCHASE');

  const moneyIn = params.salesCollected + params.customerCollections + ownerPutIn + otherIncome;
  const moneyOut =
    params.supplierPayments + shopExpenses + ownerTookOut + refunds + cashStockPurchases;
  const stillOweSuppliers = Math.max(0, params.stockBought - params.supplierPayments);

  return {
    moneyIn,
    moneyOut,
    cashLeft: moneyIn - moneyOut,
    salesCollected: params.salesCollected,
    customerCollections: params.customerCollections,
    ownerPutIn,
    otherIncome,
    supplierPayments: params.supplierPayments,
    shopExpenses,
    ownerTookOut,
    refunds,
    cashStockPurchases,
    stockBought: params.stockBought,
    stillOweSuppliers,
  };
}
