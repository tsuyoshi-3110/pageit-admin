// app/api/stripe/webhook/route.ts（管理ウェブ側）
import { stripe } from "@/lib/stripe";                // STRIPE_SECRET_KEY 初期化済み
import { adminDb } from "@/lib/firebase-admin";       // Firebase Admin SDK
import { sendMail } from "@/lib/mailer";              // Gmail OAuth2 経由の送信
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShippingDetails = {
  address?: {
    city?: string | null;
    country?: string | null;
    line1?: string | null;
    line2?: string | null;
    postal_code?: string | null;
    state?: string | null;
  } | null;
  name?: string | null;
  phone?: string | null;
};

const ZERO_DEC = new Set([
  "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"
]);
const toMajor = (n: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? (n ?? 0) : (n ?? 0) / 100;

const safeErr = (e: any) => {
  try {
    if (!e) return null;
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e).slice(0, 2000);
  } catch {
    return String(e);
  }
};

// ---------- Firestore helpers ----------
async function findSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function findSiteKeyByConnectAccount(connectAccountId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSellers")
    .where("stripe.connectAccountId", "==", connectAccountId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id; // ドキュメントID=siteKey の前提
}

async function getOwnerEmail(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

async function logOrderMail(rec: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string | null;
  sent: boolean;
  reason?: string | null;
  eventType: string;
}) {
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("orderMails").add({
    ...rec,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// ---------- HTML ----------
function buildOrderHtml(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: Stripe.ApiList<Stripe.LineItem>
) {
  const cur = (session.currency || "jpy").toUpperCase();
  const s = session.shipping_details, a = s?.address;
  const addr = [
    a?.postal_code, a?.state, a?.city, a?.line1, a?.line2, a?.country
  ].filter(Boolean).join(" ");
  const buyer = session.customer_details?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items.data.map(li => {
    const p = li.price?.product as Stripe.Product | undefined;
    const name = p?.name || li.description || "商品";
    const qty = li.quantity || 1;
    const sub = toMajor(li.amount_subtotal ?? li.amount_total ?? 0, session.currency);
    const unit = sub / (qty || 1);
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${name}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(unit).toLocaleString()}</td>
      <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${qty}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(sub).toLocaleString()}</td>
    </tr>`;
  }).join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b>／支払い: <b>${session.payment_status}</b></p>
    <p>購入者: <b>${buyer}</b></p>
    <table style="border-collapse:collapse;width:100%;max-width:680px;">
      <thead><tr>
        <th style="text-align:left;border-bottom:2px solid #333;">商品名</th>
        <th style="text-align:right;border-bottom:2px solid #333;">単価（税込）</th>
        <th style="text-align:center;border-bottom:2px solid #333;">数量</th>
        <th style="text-align:right;border-bottom:2px solid #333;">小計</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:12px;">合計: <b>¥${Math.round(total).toLocaleString()}</b> (${cur})</p>
    <h3>お届け先</h3>
    <p>氏名：${s?.name || "-"}<br/>電話：${s?.phone || "-"}<br/>住所：${addr || "-"}</p>
    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">このメールは Stripe Webhook により自動送信されています。</p>
  </div>`;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.arrayBuffer();
  const sig = (await headers()).get("stripe-signature");

  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      Buffer.from(rawBody),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err?.message || err);
    return new Response(`Webhook Error: ${err?.message ?? "invalid signature"}`, { status: 400 });
  }

  const eventType = event.type;
  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  if (eventType !== "checkout.session.completed") {
    return new Response("Unhandled event type", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string };
    shipping_details?: ShippingDetails;
  };

  try {
    // ========= 1) Firestore 保存（既存ロジックを保持） =========
    const {
      id,
      amount_total,
      currency,
      payment_status,
      customer_details,
      metadata,
    } = session;

    const itemsFromMeta = metadata?.items ? JSON.parse(metadata.items) : [];

    await adminDb.collection("siteOrders").add({
      siteKey: metadata?.siteKey || null,
      createdAt: new Date(), // 既存の挙動を維持（必要なら serverTimestamp に変更可）
      stripeCheckoutSessionId: id,
      amount: amount_total,
      currency,
      payment_status,
      customer: {
        email: customer_details?.email ?? null,
        name: customer_details?.name ?? null,
        address: customer_details?.address ?? null,
      },
      items: itemsFromMeta,
    });

    // ========= 2) siteKey の確実な解決 =========
    const customerId = (session.customer as string) || null;

    const siteKey: string | null =
      session.metadata?.siteKey
      ?? (connectedAccountId ? await findSiteKeyByConnectAccount(connectedAccountId) : null)
      ?? session.client_reference_id
      ?? (customerId ? await findSiteKeyByCustomerId(customerId) : null);

    console.log("🔎 order resolve", {
      sessionId: session.id,
      siteKey,
      connectedAccountId,
      hasCustomer: !!customerId,
    });

    if (!siteKey) {
      await logOrderMail({
        siteKey: null,
        ownerEmail: null,
        sessionId: session.id,
        sent: false,
        reason: "siteKey unresolved (metadata / event.account / client_reference_id / customer)",
        eventType,
      });
      return new Response("Order saved (no siteKey for mail)", { status: 200 });
    }

    // 初回購入で未保存ならここで stripeCustomerId を反映（将来の逆引き用）
    if (customerId) {
      await adminDb.doc(`siteSettings/${siteKey}`).set(
        { stripeCustomerId: customerId },
        { merge: true }
      );
    }

    // ========= 3) メール送信用の line items を Stripe から取得 =========
    let lineItems: Stripe.ApiList<Stripe.LineItem>;
    try {
      lineItems = await stripe.checkout.sessions.listLineItems(
        session.id,
        { expand: ["data.price.product"], limit: 100 },
        reqOpts
      );
    } catch (e) {
      await logOrderMail({
        siteKey,
        ownerEmail: null,
        sessionId: session.id,
        sent: false,
        reason: `listLineItems failed: ${safeErr(e)}`,
        eventType,
      });
      return new Response("Order saved (lineItems failed)", { status: 200 });
    }

    // ========= 4) ownerEmail を取得して送信 =========
    const ownerEmail = await getOwnerEmail(siteKey);
    if (!ownerEmail) {
      await logOrderMail({
        siteKey,
        ownerEmail: null,
        sessionId: session.id,
        sent: false,
        reason: `ownerEmail not found at siteSettings/${siteKey}`,
        eventType,
      });
      return new Response("Order saved (no ownerEmail)", { status: 200 });
    }

    const html = buildOrderHtml(session, lineItems);

    try {
      await sendMail({
        to: ownerEmail,
        subject: "【注文通知】新しい注文が完了しました",
        html,
      });
      console.log("📧 order email sent to", ownerEmail);
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        sent: true,
        eventType,
      });
    } catch (e) {
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        sent: false,
        reason: `sendMail failed: ${safeErr(e)}`,
        eventType,
      });
    }

    return new Response("Order saved & mail handled", { status: 200 });
  } catch (err) {
    console.error("🔥 webhook handler error:", safeErr(err));
    return new Response("Internal Server Error", { status: 500 });
  }
}
