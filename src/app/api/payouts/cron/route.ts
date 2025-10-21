// app/api/payouts/cron/route.ts
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RELEASE_PER_RUN = Number(process.env.PAYOUT_CRON_LIMIT ?? 100);

/** 認可：Authorization: Bearer <CRON_SECRET> または ?key=  */
function isAuthorized(req: NextRequest) {
  const hdr = req.headers.get("authorization") || "";
  const bearer = hdr.replace(/^Bearer\s+/i, "").trim();
  const keyParam = req.nextUrl.searchParams.get("key") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true; // 秘密未設定なら通す（開発用）
  return bearer === secret || keyParam === secret;
}

export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  const reqId = randomUUID();
  const log = (...a: any[]) => console.log("[payouts.cron]", reqId, ...a);
  const err = (...a: any[]) => console.error("[payouts.cron]", reqId, ...a);

  log("start", { limit: MAX_RELEASE_PER_RUN, path: req.nextUrl.pathname });

  if (!isAuthorized(req)) {
    log("unauthorized");
    return new Response("forbidden", { status: 403 });
  }

  const now = new Date();

  const snap = await adminDb
    .collection("escrows")
    .where("status", "==", "held")
    .limit(MAX_RELEASE_PER_RUN * 2) // スキップ分を加味して多めに取得
    .get();

  log("query", { total: snap.size });

  let released = 0,
    skipped = 0,
    failed = 0,
    due = 0;
  const suspendedCache = new Map<string, boolean>();

  for (const d of snap.docs) {
    if (released >= MAX_RELEASE_PER_RUN) break;

    const e = d.data() as any;

    // releaseAt: Date | Firebase Timestamp | null を Date に正規化
    const rel: Date | null =
      e?.releaseAt instanceof Date
        ? e.releaseAt
        : e?.releaseAt?.toDate?.() ?? null;

    // 期限未設定 or まだ到来していない → skip
    if (!rel || rel > now) {
      skipped++;
      continue;
    }
    due++;

    // 手動保留フラグ
    if (e?.manualHold === true) {
      skipped++;
      continue;
    }

    // サイト停止（送金停止）チェック：siteSellers/<siteKey>.payoutsSuspended === true
    const siteKey = String(e?.siteKey || "");
    if (siteKey) {
      let isSusp = suspendedCache.get(siteKey);
      if (isSusp === undefined) {
        const s = await adminDb.doc(`siteSellers/${siteKey}`).get();
        isSusp = s.exists && s.get("payoutsSuspended") === true;
        suspendedCache.set(siteKey, !!isSusp);
      }
      if (isSusp) {
        skipped++;
        continue;
      }
    }

    // 宛先・金額の最低限バリデーション
    if (
      !e?.sellerConnectId ||
      !Number.isFinite(e?.sellerAmount) ||
      e.sellerAmount <= 0
    ) {
      failed++;
      await d.ref
        .update({ lastError: "invalid destination/amount" })
        .catch(() => {});
      err("invalid", {
        escrowId: d.id,
        siteKey,
        hasDest: !!e?.sellerConnectId,
        amount: e?.sellerAmount,
      });
      continue;
    }

    // 二重実行対策：held → releasing の状態遷移をトランザクションでロック
    const locked = await adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(d.ref);
      if (!cur.exists) return false;
      if (cur.get("status") !== "held") return false;
      tx.update(d.ref, { status: "releasing", releasingAt: new Date() });
      return true;
    });
    if (!locked) {
      skipped++;
      continue;
    }

    try {
      // Stripe Transfer（Separate charges & transfers 想定）
      const tr = await stripeConnect.transfers.create(
        {
          amount: e.sellerAmount,
          currency: e.currency, // 例: "jpy"
          destination: e.sellerConnectId,
          transfer_group: e.transferGroup || undefined,
          // source_transaction: e.chargeId || undefined, // 必要に応じて
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
      log("released", {
        escrowId: d.id,
        siteKey,
        amount: e.sellerAmount,
        currency: e.currency,
        transferId: tr.id,
      });
    } catch (ex: any) {
      await d.ref
        .update({
          status: "held", // 元に戻す
          releasingAt: null,
          lastError: String(ex?.message || ex),
        })
        .catch(() => {});
      failed++;
      err("transfer_failed", {
        escrowId: d.id,
        siteKey,
        message: String(ex?.message || ex),
      });
    }
  }

  log("done", { queried: snap.size, due, released, skipped, failed });

  return Response.json({
    queried: snap.size,
    due,
    released,
    skipped,
    failed,
    limit: MAX_RELEASE_PER_RUN,
    now: now.toISOString(),
    reqId,
  });
}
