export type Money = {
  amountCents: number;
  currency: "EUR";
};

export function calculateDeposit(total: Money, percentage: number): Money {
  const safePercentage = Math.min(100, Math.max(0, percentage));
  const amountCents = Math.round((total.amountCents * safePercentage) / 100);
  return { amountCents, currency: total.currency };
}
