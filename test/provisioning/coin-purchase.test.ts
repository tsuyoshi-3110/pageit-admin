import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addPurchasedCoins, isCoinPurchase } from "@/lib/stripe/coin-purchase";

const NOW = new Date("2026-11-06T00:00:00Z");
const paid = {
  id: "cs_1",
  payment_status: "paid",
  metadata: { type: "pageit_xeno_coin_pack", siteKey: "shop", coins: "500" },
};

describe("XenoCoin の購入", () => {
  test("Pageit の購入だけを判定する", () => {
    assert.equal(isCoinPurchase(paid), true);
    assert.equal(isCoinPurchase({ metadata: { type: "xeno_coin_pack" } }), false);
    assert.equal(isCoinPurchase({ metadata: null }), false);
  });

  test("支払い済みなら6か月有効のコインを足す", () => {
    const lots = addPurchasedCoins([], paid, NOW);
    assert.equal(lots?.length, 1);
    assert.equal(lots?.[0].left, 500);
    assert.equal(lots?.[0].expiresAt, "2027-05-06T00:00:00.000Z");
  });

  test("月末の購入でも6か月を超えない", () => {
    const expiryOf = (iso: string) => addPurchasedCoins([], paid, new Date(iso))?.[0].expiresAt;
    assert.equal(expiryOf("2026-08-31T03:00:00Z"), "2027-02-28T03:00:00.000Z");
    // 日本時間の 8/31 0:00 は UTC では 8/30 です
    assert.equal(expiryOf("2026-08-30T15:00:00Z"), "2027-02-27T15:00:00.000Z");
  });

  test("同じ決済を二重に足さない", () => {
    const lots = addPurchasedCoins([], paid, NOW);
    assert.equal(addPurchasedCoins(lots, paid, NOW), null);
  });

  test("未払いや不正なコイン数は足さない", () => {
    assert.equal(addPurchasedCoins([], { ...paid, payment_status: "unpaid" }, NOW), null);
    assert.equal(addPurchasedCoins([], { ...paid, metadata: { coins: "x" } }, NOW), null);
  });
});
