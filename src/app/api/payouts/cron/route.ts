import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RELEASE_PER_RUN = Number(process.env.PAYOUT_CRON_LIMIT ?? 100);

function isAuthorized(req: NextRequest) {
  const hdr = req.headers.get("authorization") || "";
  const bearer = hdr.replace(/^Bearer\s+/i, "").trim();
  const keyParam = new URL(req.url).searchParams.get("key") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true;
  return bearer === secret || keyParam === secret;
}

export async function GET(req: NextRequest) { return POST(req); }

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return new Response("forbidden", { status: 403 });

  const now = new Date();
  const snap = await adminDb
    .collection("escrows")
    .where("status", "==", "held")
    .limit(MAX_RELEASE_PER_RUN * 2)
    .get();

  let released = 0, skipped = 0, failed = 0, due = 0;
  const suspendedCache = new Map<string, boolean>();

  for (const d of snap.docs) {
    if (released >= MAX_RELEASE_PER_RUN) break;
    const e = d.data() as any;

    const rel: Date | null = e.releaseAt instanceof Date ? e.releaseAt : e.releaseAt?.toDate?.() ?? null;
    if (!rel || rel > now) { skipped++; continue; }
    due++;

    if (e.manualHold === true) { skipped++; continue; }

    const siteKey = String(e.siteKey || "");
    if (siteKey) {
      let isSusp = suspendedCache.get(siteKey);
      if (isSusp === undefined) {
        const s = await adminDb.doc(`siteSellers/${siteKey}`).get();
        isSusp = s.exists && s.get("payoutsSuspended") === true;
        suspendedCache.set(siteKey, !!isSusp);
      }
      if (isSusp) { skipped++; continue; }
    }

    if (!e.sellerConnectId || !Number.isFinite(e.sellerAmount) || e.sellerAmount <= 0) {
      failed++; await d.ref.update({ lastError: "invalid destination/amount" }).catch(() => {}); continue;
    }

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
          currency: e.currency,
          destination: e.sellerConnectId,
          transfer_group: e.transferGroup || undefined,
          // source_transaction: e.chargeId || undefined,
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
      await d.ref.update({ status: "held", releasingAt: null, lastError: String(err?.message || err) }).catch(() => {});
      failed++;
    }
  }

  return Response.json({ queried: snap.size, due, released, skipped, failed, limit: MAX_RELEASE_PER_RUN, now: now.toISOString() });
}
