// app/api/payouts/release-site/route.ts
import { adminDb } from "@/lib/firebase-admin";
import { stripeConnect } from "@/lib/stripe-connect";
import { FieldValue } from "firebase-admin/firestore"; // ★ 追加

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const siteKey: string | undefined = body?.siteKey;
  const force: boolean = body?.force === true;
  const limit: number = Number(body?.limit ?? 20);

  if (!siteKey) return new Response("siteKey required", { status: 400 });

  const now = new Date();

  const sellerDoc = await adminDb.doc(`siteSellers/${siteKey}`).get();
  const payoutsSuspended = sellerDoc.exists && sellerDoc.get("payoutsSuspended") === true;

  let q = adminDb
    .collection("escrows")
    .where("siteKey", "==", siteKey)
    .where("status", "==", "held");

  if (!force) q = q.where("releaseAt", "<=", now);

  const snap = await q.limit(limit).get();

  let released = 0;
  let skipped = 0;
  const errors: Array<{ id: string; code?: string; message: string }> = [];

  for (const d of snap.docs) {
    const e = d.data() as any;

    if ((payoutsSuspended || e.manualHold === true) && !force) {
      skipped++;
      continue;
    }

    const locked = await adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(d.ref);
      if (!cur.exists) return false;
      if (cur.get("status") !== "held") return false;
      tx.update(d.ref, {
        status: "releasing",
        releasingAt: new Date(),
        lastError: FieldValue.delete(),              // ★ 修正
      });
      return true;
    });
    if (!locked) { skipped++; continue; }

    try {
      const hasCharge = typeof e.chargeId === "string" && e.chargeId.startsWith("ch_");
      const params: Parameters<typeof stripeConnect.transfers.create>[0] = {
        amount: e.sellerAmount,
        currency: e.currency,
        destination: e.sellerConnectId,
        transfer_group: e.transferGroup || undefined,
        ...(hasCharge ? { source_transaction: e.chargeId } : {}),
      };

      const tr = await stripeConnect.transfers.create(params, {
        idempotencyKey: `transfer_${d.id}`,
      });

      await d.ref.update({
        status: "transferred",
        transferId: tr.id,
        transferredAt: new Date(),
        releasingAt: null,
        lastError: FieldValue.delete(),              // ★ 修正
      });
      released++;
    } catch (err: any) {
      const code = err?.code || err?.raw?.code;
      const message = err?.message || String(err);

      await d.ref.update({
        status: "held",
        releasingAt: null,
        lastError: { code: code || null, message, at: new Date() }, // 失敗理由を保持
      });
      errors.push({ id: d.id, code, message });
      skipped++;
    }
  }

  return new Response(JSON.stringify({ released, skipped, errors }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
