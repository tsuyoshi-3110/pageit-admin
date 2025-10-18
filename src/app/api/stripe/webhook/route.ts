// app/api/stripe/webhook/route.ts（管理ウェブ側）
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------- 型・ユーティリティ -------------------- */
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
  "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf",
]);
const toMajor = (n: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? (n ?? 0) : (n ?? 0) / 100;

const safeErr = (e: unknown) => {
  try {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
};

/* -------------------- Firestore helpers -------------------- */
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
  return snap.empty ? null : snap.docs[0].id; // ドキュメントID=siteKey 前提
}

async function getOwnerEmail(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

async function logOrderMail(rec: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string;
  eventType: string;
  sent: boolean;
  reason?: string | null;
  extras?: Record<string, unknown>;
}) {
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("orderMails").add({
    ...rec,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* -------------------- メールHTML -------------------- */
function buildOrderHtmlFromItems(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }>
) {
  const cur = (session.currency || "jpy").toUpperCase();

  // shipping_details が無い環境でも customer_details をフォールバックで使う
  const ship = (session as any).shipping_details as
    | { name?: string | null; phone?: string | null; address?: Stripe.Address | null }
    | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-"; // ← 電話は customer_details を優先
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;

  const addr = [
    addrObj?.postal_code ? `〒${addrObj.postal_code}` : "",
    addrObj?.state,
    addrObj?.city,
    addrObj?.line1,
    addrObj?.line2,
    addrObj?.country && addrObj.country !== "JP" ? addrObj.country : "",
  ]
    .filter(Boolean)
    .join(" ");

  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items
    .map((it) => {
      const unit = it.unitAmount;
      const sub = typeof it.subtotal === "number" ? it.subtotal : unit * it.qty;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${it.name}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(unit).toLocaleString()}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(sub).toLocaleString()}</td>
      </tr>`;
    })
    .join("");

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
    <p>氏名：${name}<br/>電話：${phone}<br/>住所：${addr || "-"}</p>
    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">このメールは Stripe Webhook により自動送信されています。</p>
  </div>`;
}

/* ============================================================
   Webhook
============================================================ */
export async function POST(req: NextRequest) {
  const rawBody = await req.arrayBuffer();
  const sig = (await headers()).get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature header", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      Buffer.from(rawBody),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", safeErr(err));
    return new Response("Webhook Error", { status: 400 });
  }

  const eventType = event.type;
  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  if (eventType !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string; items?: string };
    shipping_details?: ShippingDetails;
  };

  try {
    /* ---------- 1) Firestore 保存（電話番号も保存） ---------- */
    const itemsFromMeta: Array<{ name: string; qty: number; unitAmount: number }> =
      session.metadata?.items ? JSON.parse(session.metadata.items) : [];

    // 電話番号は customer_details.phone を優先、無ければ shipping_details.phone
    const customerPhone =
      session.customer_details?.phone ??
      (session as any).shipping_details?.phone ??
      null;

    await adminDb.collection("siteOrders").add({
      siteKey: session.metadata?.siteKey || null,
      createdAt: new Date(),
      stripeCheckoutSessionId: session.id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      customer: {
        email: session.customer_details?.email ?? null,
        name: session.customer_details?.name ?? (session as any).shipping_details?.name ?? null,
        phone: customerPhone, // ← 追加保存
        address:
          session.customer_details?.address ??
          (session as any).shipping_details?.address ??
          null,
      },
      items: itemsFromMeta,
    });

    /* ---------- 2) siteKey 解決 ---------- */
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
      hasMetaItems: itemsFromMeta.length > 0,
      hasShipping: !!(session as any).shipping_details,
      hasCustomerAddress: !!session.customer_details?.address,
      hasPhone: !!customerPhone,
    });

    if (!siteKey) {
      await logOrderMail({
        siteKey: null,
        ownerEmail: null,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: "siteKey unresolved",
        extras: { connectedAccountId, customerId, metadata: session.metadata ?? null },
      });
      return new Response("Order saved (no siteKey for mail)", { status: 200 });
    }

    // 初回購入で未保存なら stripeCustomerId を保存
    if (customerId) {
      await adminDb.doc(`siteSettings/${siteKey}`).set({ stripeCustomerId: customerId }, { merge: true });
    }

    /* ---------- 3) ownerEmail 取得 ---------- */
    const ownerEmail = await getOwnerEmail(siteKey);
    if (!ownerEmail) {
      await logOrderMail({
        siteKey,
        ownerEmail: null,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: `ownerEmail not found at siteSettings/${siteKey}`,
      });
      return new Response("Order saved (no ownerEmail)", { status: 200 });
    }

    /* ---------- 4) メール items 準備（metadata 優先、なければ Stripe から取得） ---------- */
    let mailItems: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }> = itemsFromMeta;

    if (!mailItems.length) {
      try {
        const li = await stripe.checkout.sessions.listLineItems(
          session.id,
          { expand: ["data.price.product"], limit: 100 },
          reqOpts
        );
        mailItems = li.data.map((x) => {
          const name = (x.price?.product as Stripe.Product | undefined)?.name || x.description || "商品";
          const qty = x.quantity || 1;
          const subtotal = toMajor(x.amount_subtotal ?? x.amount_total ?? 0, session.currency);
          const unit = subtotal / Math.max(1, qty);
          return { name, qty, unitAmount: unit, subtotal };
        });
      } catch (e) {
        console.warn("⚠️ listLineItems failed, fallback to minimal:", safeErr(e));
        mailItems = [{ name: "（明細の取得に失敗）", qty: 1, unitAmount: toMajor(session.amount_total, session.currency) }];
      }
    }

    const html = buildOrderHtmlFromItems(session, mailItems);

    /* ---------- 5) 送信 ---------- */
    try {
      await sendMail({
        to: ownerEmail,
        subject: "【注文通知】新しい注文が完了しました",
        html,
        // replyTo: session.customer_details?.email || undefined,
      });
      console.log("📧 order email sent to", ownerEmail);
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        eventType,
        sent: true,
      });
    } catch (e) {
      console.error("❌ sendMail failed:", safeErr(e));
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: `sendMail failed: ${safeErr(e)}`,
      });
    }

    /* ---------- ★追加：購入者（消費者）にもレシート送信 ---------- */
    try {
      const buyerEmail =
        session.customer_details?.email || session.customer_email || null;
      if (buyerEmail) {
        await sendMail({
          to: buyerEmail,
          subject: "ご購入ありがとうございます（ご注文のレシート）",
          html, // 上で生成したレシートHTMLをそのまま利用
        });
        console.log("📧 receipt email sent to buyer", buyerEmail);
      } else {
        console.log("ℹ️ buyer email not found; receipt skipped");
      }
    } catch (e) {
      console.error("❌ sendMail to buyer failed:", safeErr(e));
      // 他の処理は継続
    }
    /* ---------- ★ここまで追加 ---------- */

    return new Response("Order saved & mail handled", { status: 200 });
  } catch (err) {
    console.error("🔥 webhook handler error:", safeErr(err));
    await logOrderMail({
      siteKey: session.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: session.id,
      eventType,
      sent: false,
      reason: `handler error: ${safeErr(err)}`,
    });
    return new Response("Internal Server Error", { status: 500 });
  }
}
