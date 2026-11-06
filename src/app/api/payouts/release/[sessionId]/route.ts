// app/api/payouts/release/[sessionId]/route.ts
import { requireAdmin } from "@/app/api/_utils/auth";
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  // ← ルートの第2引数は使わず、URL から動的セグメントを取得
  const url = new URL(req.url);
  const parts = url.pathname.split("/");
  const sessionId = decodeURIComponent(parts[parts.length - 1] || "");
  if (!sessionId) return new Response("sessionId missing", { status: 400 });

  // 1) エスクロー取得
  const ref = adminDb.collection("escrows").doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return new Response("not found", { status: 404 });

  const e = snap.data() as {
    siteKey?: string | null;
    status: string;
    currency: string;
    sellerAmount: number; // 最小通貨単位
    sellerConnectId: string | null;
    transferGroup?: string | null;
    releaseAt?: FirebaseFirestore.Timestamp | Date | number | null;
    transferId?: string | null;
    manualHold?: boolean;
  };

  // 2) すでに送金済みなら何もしない
  if (e.status === "transferred" && e.transferId) {
    return new Response("already transferred", { status: 200 });
  }

  // 3) 期日チェック（?force=1 で強制解放可）
  const force = url.searchParams.get("force") === "1";
  const nowMs = Date.now();
  const relMs =
    e.releaseAt instanceof Date
      ? e.releaseAt.getTime()
      : typeof e.releaseAt === "number"
      ? e.releaseAt
      : (e.releaseAt as any)?.toDate?.()?.getTime?.() ?? 0;

  if (!force && relMs && relMs > nowMs) {
    return new Response("not yet releasable", { status: 400 });
  }

  // 4) 金額・宛先チェック
  if (!e.sellerConnectId) {
    return new Response("sellerConnectId missing", { status: 400 });
  }
  if (!Number.isFinite(e.sellerAmount) || e.sellerAmount! <= 0) {
    return new Response("amount invalid", { status: 400 });
  }

  // 5) 🔒 送金停止ガード
  const siteKey = (e as any).siteKey || null;
  if (siteKey) {
    const sDoc = await adminDb.doc(`siteSellers/${siteKey}`).get();
    if (sDoc.exists && sDoc.get("payoutsSuspended") === true) {
      return new Response("seller payouts suspended", { status: 400 });
    }
  }
  if ((e as any).manualHold === true) {
    return new Response("escrow is manually on hold", { status: 400 });
  }

  // 6) Stripe transfer 実行（プラットフォーム残高→セラー）
  const tr = await stripeConnect.transfers.create(
    {
      amount: e.sellerAmount,
      currency: e.currency,
      destination: e.sellerConnectId,
      transfer_group: e.transferGroup || undefined,
    },
    { idempotencyKey: `transfer_${sessionId}` }
  );

  // 7) エスクロー更新
  await ref.update({
    status: "transferred",
    transferId: tr.id,
    transferredAt: new Date(),
  });

  return new Response("ok");
}
