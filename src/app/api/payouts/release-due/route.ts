// app/api/payouts/release-due/route.ts
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));
  const now = new Date();

  // 🔧 グローバルKill-Switch（自動送金だけ止める）
  try {
    const g = await adminDb.doc("adminSettings/global").get();
    if (g.exists && g.get("autoPayoutsDisabled") === true) {
      return new Response(
        JSON.stringify({ found: 0, released: 0, skipped: 0, failed: 0, reason: "auto_disabled_global" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch {
    // 読み取り失敗しても自動停止扱いにはしない（通常続行）
  }

  // 期日到来・保留中のエスクローを取得
  const snap = await adminDb
    .collection("escrows")
    .where("status", "==", "held")
    .where("releaseAt", "<=", now)
    .limit(limit)
    .get();

  const found = snap.size;
  let released = 0;
  let skipped = 0;
  let failed = 0;

  for (const d of snap.docs) {
    const e = d.data() as any;

    // 手動ホールドはスキップ（管理者が明示的に保留中のもの）
    if (e.manualHold === true) { skipped++; continue; }

    const siteKey = e.siteKey || null;

    // 店舗側のフラグ確認
    if (siteKey) {
      try {
        const sDoc = await adminDb.doc(`siteSellers/${siteKey}`).get();
        if (sDoc.exists) {
          // 完全停止（自動も手動も不可）
          if (sDoc.get("payoutsSuspended") === true) { skipped++; continue; }
          // 自動送金だけ停止（手動はOK）
          if (sDoc.get("autoPayoutsDisabled") === true) { skipped++; continue; }
        }
      } catch {
        // 読み取り失敗時は停止扱いにせず通常続行
      }
    }

    // 宛先・金額チェック
    if (!e.sellerConnectId || !Number.isFinite(e.sellerAmount) || e.sellerAmount <= 0) {
      failed++;
      await d.ref.update({ lastError: "invalid destination/amount" }).catch(() => {});
      continue;
    }

    // 二重実行ガード（ロック）
    const locked = await adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(d.ref);
      if (!cur.exists) return false;
      if (cur.get("status") !== "held") return false;
      tx.update(d.ref, { status: "releasing", releasingAt: new Date() });
      return true;
    });
    if (!locked) { skipped++; continue; }

    try {
      const tr = await stripeConnect.transfers.create(
        {
          amount: e.sellerAmount,
          currency: e.currency || "jpy",
          destination: e.sellerConnectId,
          transfer_group: e.transferGroup || undefined,
        },
        { idempotencyKey: `transfer_${d.id}` }
      );

      await d.ref.update({
        status: "transferred",
        transferId: tr.id,
        transferredAt: new Date(),
        releasingAt: null,
        lastError: null,
      });
      released++;
    } catch (err: any) {
      // 失敗したらロック解除して次回リトライ
      await d.ref.update({
        status: "held",
        releasingAt: null,
        lastError: typeof err?.message === "string" ? err.message : String(err),
      }).catch(() => {});
      failed++;
    }
  }

  return new Response(JSON.stringify({ found, released, skipped, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
