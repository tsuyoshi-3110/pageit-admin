// app/api/payouts/cron/route.ts
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RELEASE_PER_RUN = Number(process.env.PAYOUT_CRON_LIMIT ?? 100);
const IDEM_MISMATCH_RE =
  /Keys for idempotent requests can only be used with the same parameters/i;

function isAuthorized(req: NextRequest) {
  const hdr = req.headers.get("authorization") || "";
  const bearer = hdr.replace(/^Bearer\s+/i, "").trim();
  const keyParam = req.nextUrl.searchParams.get("key") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true;
  return bearer === secret || keyParam === secret;
}

export async function GET(req: NextRequest) {
  return POST(req);
}

// 売上の原資（Charge）を解決
async function resolveSourceTxn(e: any): Promise<string | null> {
  if (typeof e?.sourceTransaction === "string" && e.sourceTransaction)
    return e.sourceTransaction;
  if (typeof e?.chargeId === "string" && e.chargeId) return e.chargeId;
  if (typeof e?.balanceTxId === "string" && e.balanceTxId) return e.balanceTxId;

  const piId = typeof e?.paymentIntentId === "string" ? e.paymentIntentId : null;
  if (!piId) return null;

  const pi = (await stripeConnect.paymentIntents.retrieve(
    piId
  )) as Stripe.Response<Stripe.PaymentIntent>;
  const lc = pi.latest_charge as string | Stripe.Charge | null;
  if (!lc) return null;
  return typeof lc === "string" ? lc : lc.id || null;
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
    .limit(MAX_RELEASE_PER_RUN * 2)
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

    // 期日チェック
    const rel: Date | null =
      e?.releaseAt instanceof Date
        ? e.releaseAt
        : e?.releaseAt?.toDate?.() ?? null;
    if (!rel || rel > now) {
      skipped++;
      continue;
    }
    due++;

    // 手動保留
    if (e?.manualHold === true) {
      skipped++;
      continue;
    }

    // サイト停止チェック
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

    // 宛先・金額チェック
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

    // 売上（Charge）を特定
    let sourceTxn: string | null = null;
    try {
      sourceTxn = await resolveSourceTxn(e);
    } catch (ex: any) {
      err("resolve_source_failed", {
        escrowId: d.id,
        siteKey,
        message: String(ex?.message || ex),
      });
    }
    if (!sourceTxn) {
      failed++;
      await d.ref
        .update({
          lastError:
            "missing source_transaction (chargeId/paymentIntent.latest_charge)",
        })
        .catch(() => {});
      err("no_source_transaction", { escrowId: d.id, siteKey });
      continue;
    }

    // 二重実行対策（held→releasing）
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

    // transfers.create（手動と同じ：source_transaction あり＋idempotency再試行）
    const currency = ((e.currency ?? "jpy") as string).toLowerCase();
    const params: Stripe.TransferCreateParams = {
      amount: e.sellerAmount,
      currency, // stringでOK
      destination: e.sellerConnectId,
      transfer_group: e.transferGroup || undefined,
      source_transaction: sourceTxn,
    };

    const baseKey = `transfer_v2_${d.id}`;
    const idemKey = `${baseKey}_src`;

    try {
      const tr = await stripeConnect.transfers.create(params, {
        idempotencyKey: idemKey,
      });

      await d.ref.update({
        status: "transferred",
        transferId: tr.id,
        transferredAt: new Date(),
        releasingAt: null,
        lastError: null,
        sourceTransaction: sourceTxn,
      });
      released++;
      log("released", {
        escrowId: d.id,
        siteKey,
        amount: e.sellerAmount,
        currency,
        transferId: tr.id,
      });
    } catch (ex: any) {
      // idempotency mismatch → 別キーで1回だけ再試行
      if (IDEM_MISMATCH_RE.test(String(ex?.message || ex))) {
        try {
          const retryKey = `${idemKey}_${Date.now()}`;
          const tr = await stripeConnect.transfers.create(params, {
            idempotencyKey: retryKey,
          });

          await d.ref.update({
            status: "transferred",
            transferId: tr.id,
            transferredAt: new Date(),
            releasingAt: null,
            lastError: null,
            sourceTransaction: sourceTxn,
          });
          released++;
          log("released_retry", {
            escrowId: d.id,
            siteKey,
            amount: e.sellerAmount,
            currency,
            transferId: tr.id,
          });
          continue;
        } catch (ex2: any) {
          await d.ref
            .update({
              status: "held",
              releasingAt: null,
              lastError: String(ex2?.message || ex2),
            })
            .catch(() => {});
          failed++;
          err("transfer_failed_retry", {
            escrowId: d.id,
            siteKey,
            message: String(ex2?.message || ex2),
            sourceTxn,
          });
          continue;
        }
      }

      await d.ref
        .update({
          status: "held",
          releasingAt: null,
          lastError: String(ex?.message || ex),
        })
        .catch(() => {});
      failed++;
      err("transfer_failed", {
        escrowId: d.id,
        siteKey,
        message: String(ex?.message || ex),
        sourceTxn,
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
