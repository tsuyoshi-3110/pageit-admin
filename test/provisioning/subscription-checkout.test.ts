import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isSubscriptionCheckout,
  subscriptionFieldsOf,
} from "@/lib/stripe/subscription-checkout";

describe("サブスクの支払い通知", () => {
  test("サブスクの申し込みだけを判定する", () => {
    assert.equal(isSubscriptionCheckout({ mode: "subscription" }), true);
    assert.equal(isSubscriptionCheckout({ mode: "payment" }), false);
    assert.equal(isSubscriptionCheckout({ mode: "setup" }), false);
  });

  test("顧客とサブスクのIDを取り出す", () => {
    assert.deepEqual(subscriptionFieldsOf({ customer: "cus_1", subscription: "sub_1" }), {
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
    assert.deepEqual(
      subscriptionFieldsOf({ customer: { id: "cus_2" } as any, subscription: { id: "sub_2" } as any }),
      { stripeCustomerId: "cus_2", stripeSubscriptionId: "sub_2" }
    );
  });

  test("IDがなければ項目を作らない", () => {
    assert.deepEqual(subscriptionFieldsOf({ customer: null, subscription: null }), {});
  });
});
