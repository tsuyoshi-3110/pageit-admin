import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isIdempotencyMismatch(e: unknown) {
  const msg = String((e as any)?.message ?? e ?? "");
  return /Keys for idempotent requests can only be used with the same parameters/i.test(msg);
}

export async function POST(req: Request) {
  // --- 入力 ---
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const siteKey = typeof body.siteKey === "string" ? body.siteKey : "";
  const force: boolean = body.force === true;
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 50)));
  if (!siteKey) {
    return new Response(JSON.stringify({ error: "siteKey is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date();

  // サイトの送金停止フラグ（true なら全スキップ）
  const sellerDoc = await adminDb.doc(`siteSellers/${siteKey}`).get();
  const suspended = sellerDoc.exists && sellerDoc.get("payoutsSuspended") === true;

  // --- クエリ（releaseAt の条件は後段フィルタ）---
  const snap = await adminDb
    .collection("escrows")
    .where("status", "==", "held")
    .where("siteKey", "==", siteKey)
    .limit(limit * 2)
    .get();

  let released = 0;
  let skipped = 0;
  let failed = 0;
  let due = 0;

  if (suspended) {
    return new Response(
      JSON.stringify({
        queried: snap.size,
        due,
        released,
        skipped: snap.size,
        failed,
        suspended: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  for (const d of snap.docs) {
    const e = d.data() as any;

    // 手動ホールドはスキップ
    if (e.manualHold === true) { skipped++; continue; }

    // 期日条件（force=false の時だけチェック）
    if (!force) {
      const rel =
        e.releaseAt instanceof Date
          ? e.releaseAt
          : e.releaseAt?.toDate?.() ?? null;
      if (!rel || rel > now) { skipped++; continue; }
    }
    due++;

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

    // --- Transfer 作成（source_transaction を極力使う） ---
    const baseParams: Stripe.TransferCreateParams = {
      amount: e.sellerAmount,
      currency: (e.currency || "jpy").toLowerCase(),
      destination: e.sellerConnectId,
      transfer_group: e.transferGroup || undefined,
    };

    // chargeId があれば SCT の資金紐付けとして使用
    const useSource = !!e.chargeId;
    const params: Stripe.TransferCreateParams = useSource
      ? { ...baseParams, source_transaction: e.chargeId }
      : baseParams;

    // idempotency key はパラメータセットごとに分ける（mismatch回避）
    const baseKey = `transfer_v2_${d.id}`;
    const idemKey = useSource ? `${baseKey}_src` : `${baseKey}_plain`;

    try {
      const tr = await stripeConnect.transfers.create(params, { idempotencyKey: idemKey });

      await d.ref.update({
        status: "transferred",
        transferId: tr.id,
        transferredAt: new Date(),
        releasingAt: null,
        lastError: null,
      });
      released++;
      if (released >= limit) break;
    } catch (err: any) {
      // idempotent key の不整合は、別キーで 1 回だけリトライ
      if (isIdempotencyMismatch(err)) {
        try {
          const retryKey = `${idemKey}_${Date.now()}`;
          const tr = await stripeConnect.transfers.create(params, { idempotencyKey: retryKey });

          await d.ref.update({
            status: "transferred",
            transferId: tr.id,
            transferredAt: new Date(),
            releasingAt: null,
            lastError: null,
          });
          released++;
          if (released >= limit) break;
          continue;
        } catch (err2: any) {
          await d.ref.update({
            status: "held",
            releasingAt: null,
            lastError: String(err2?.message ?? err2),
          }).catch(() => {});
          failed++;
          continue;
        }
      }

      // その他エラー：ロック解除して次回リトライ
      await d.ref.update({
        status: "held",
        releasingAt: null,
        lastError: String(err?.message ?? err),
      }).catch(() => {});
      failed++;
    }
  }

  return new Response(
    JSON.stringify({
      queried: snap.size,
      due,
      released,
      skipped,
      failed,
      suspended: false,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
