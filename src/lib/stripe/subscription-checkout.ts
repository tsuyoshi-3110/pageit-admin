import type Stripe from "stripe";

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id ?? null;

/**
 * 月額サブスクの申し込みかどうかを判定します。
 * 商品の注文ではないため、注文の記録や売上の保留、注文メールの対象にしません。
 */
export function isSubscriptionCheckout(session: Pick<Stripe.Checkout.Session, "mode">) {
  return session.mode === "subscription";
}

/** 店舗の設定に記録する、Stripeの顧客とサブスクのIDです。 */
export function subscriptionFieldsOf(
  session: Pick<Stripe.Checkout.Session, "customer" | "subscription">
) {
  const customerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);
  return {
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
  };
}
