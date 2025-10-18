import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

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

const ZERO_DEC = new Set(["bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"]);
const toMajor = (n:number|null|undefined, cur?:string|null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? (n ?? 0) : (n ?? 0) / 100;

const safeErr = (e:any) => {
  try {
    if (!e) return null;
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e).slice(0, 2000);
  } catch { return String(e); }
};

// ---------- Firestore helpers ----------
async function findSiteKeyByCustomerId(customerId: string): Promise<string|null> {
  const snap = await adminDb.collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function findSiteKeyByConnectAccount(connectAccountId: string): Promise<string|null> {
  const snap = await adminDb.collection("siteSellers")
    .where("stripe.connectAccountId", "==", connectAccountId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  // ドキュメントIDを siteKey にしている構造ならそれを返す
  return snap.docs[0].id;
}

async function getOwnerEmail(siteKey: string): Promise<string|null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

async function saveCustomerId(siteKey: string, customerId: string | null) {
  if (!customerId) return;
  await adminDb.doc(`siteSettings/${siteKey}`).set(
    { stripeCustomerId: customerId, subscriptionStatus: "active" },
    { merge: true }
  );
}

async function logOrderMail(rec: {
  siteKey: string|null;
  ownerEmail: string|null;
  sessionId: string|null;
  sent: boolean;
  reason?: string|null;
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
  const addr = [a?.postal_code, a?.state, a?.city, a?.line1, a?.line2, a?.country].filter(Boolean).join(" ");
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
  </div>`;
}

// ---------- Webhook ----------
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("No signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, endpointSecret);
  } catch (e) {
    console.error("❌ Invalid signature:", safeErr(e));
    return new NextResponse("Webhook Error", { status: 400 });
  }

  const eventType = event.type;
  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  try {
    if (eventType === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session & {
        metadata?: { siteKey?: string },
        shipping_details?: ShippingDetails
      };

      // --- siteKey の解決順 ---
      const siteKey: string | null =
        session.metadata?.siteKey
          ?? (connectedAccountId ? await findSiteKeyByConnectAccount(connectedAccountId) : null)
          ?? session.client_reference_id
          ?? (session.customer ? await findSiteKeyByCustomerId(session.customer as string) : null);

      console.log("🔎 order resolve", {
        sessionId: session.id,
        siteKey,
        connectedAccountId,
        hasCustomer: !!session.customer,
      });

      if (!siteKey) {
        await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: session.id, sent: false, reason: "siteKey unresolved", eventType });
        return NextResponse.json({ ok: true });
      }

      // 初回購入などで customerId 未保存ならここで保存しておく
      if (session.customer) {
        await saveCustomerId(siteKey, session.customer as string);
      }

      // 明細取得（Connect 文脈で）
      let items: Stripe.ApiList<Stripe.LineItem>;
      try {
        items = await stripe.checkout.sessions.listLineItems(
          session.id,
          { expand: ["data.price.product"], limit: 100 },
          reqOpts
        );
      } catch (e) {
        await logOrderMail({
          siteKey, ownerEmail: null, sessionId: session.id,
          sent: false, reason: `listLineItems failed: ${safeErr(e)}`, eventType
        });
        return NextResponse.json({ ok: true });
      }

      const ownerEmail = await getOwnerEmail(siteKey);
      if (!ownerEmail) {
        await logOrderMail({
          siteKey, ownerEmail: null, sessionId: session.id,
          sent: false, reason: `ownerEmail not found at siteSettings/${siteKey}`, eventType
        });
        return NextResponse.json({ ok: true });
      }

      const html = buildOrderHtml(session, items);

      try {
        await sendMail({ to: ownerEmail, subject: "【注文通知】新しい注文が完了しました", html });
        console.log("📧 sent to", ownerEmail);
        await logOrderMail({ siteKey, ownerEmail, sessionId: session.id, sent: true, eventType });
      } catch (e) {
        await logOrderMail({
          siteKey, ownerEmail, sessionId: session.id, sent: false,
          reason: `sendMail failed: ${safeErr(e)}`, eventType
        });
      }

      return NextResponse.json({ ok: true });
    }

    // --- オーナーの月額決済（親アカウント側のイベント）：状態だけ更新 ---
    if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      const siteKey = customerId ? await findSiteKeyByCustomerId(customerId) : null;
      if (siteKey) {
        await adminDb.doc(`siteSettings/${siteKey}`).set(
          { subscriptionStatus: eventType === "invoice.paid" ? "active" : "unpaid" },
          { merge: true }
        );
      }
      return NextResponse.json({ ok: true });
    }

    // その他のイベントは無視
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("🔥 handler error:", safeErr(e));
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
