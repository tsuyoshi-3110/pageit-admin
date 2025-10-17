// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebase-admin";
import { stripe } from "@/lib/stripe";
import { sendMail } from "@/lib/mailer";

// App Router で raw body を扱うため
export const runtime = "nodejs";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const vercelToken = process.env.VERCEL_TOKEN!;

// ===== 型補助（Stripe SDK に export のない shipping_details 用）=====
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

// ===== 通貨ヘルパー（JPY 等のゼロ小数通貨対応）=====
const ZERO_DECIMAL = new Set([
  "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf",
]);
const toMajor = (amount: number | null | undefined, currency?: string | null) => {
  const a = amount ?? 0;
  const c = (currency ?? "jpy").toLowerCase();
  return ZERO_DECIMAL.has(c) ? a : a / 100;
};

// ===== Firestore helpers =====
async function getSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function getOwnerEmailBySiteKey(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

// ===== Vercel Project delete（既存機能の堅牢化）=====
async function deleteVercelProject(siteKey: string) {
  try {
    const res = await fetch(`https://api.vercel.com/v9/projects/${siteKey}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("Vercel project deletion failed:", err);
    } else {
      console.log(`✅ Deleted Vercel project "${siteKey}"`);
    }
  } catch (e) {
    console.error("deleteVercelProject error:", e);
  }
}

// ===== 注文メール HTML =====
function buildOrderHtml(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  lineItems: Stripe.ApiList<Stripe.LineItem>
) {
  const currency = (session.currency || "jpy").toUpperCase();
  const shipping = session.shipping_details;
  const address = shipping?.address;

  const addressLine = [
    address?.postal_code,
    address?.state,
    address?.city,
    address?.line1,
    address?.line2,
    address?.country,
  ].filter(Boolean).join(" ");

  const buyerEmail = session.customer_details?.email || session.customer_email || "-";
  const name = shipping?.name || "-";
  const phone = shipping?.phone || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = lineItems.data.map((li) => {
    const prod = li.price?.product as Stripe.Product | undefined;
    const pname = prod?.name || li.description || "商品";
    const qty = li.quantity || 1;
    const subtotal = toMajor(li.amount_subtotal ?? li.amount_total ?? 0, session.currency);
    const unit = subtotal / (qty || 1);
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${pname}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(unit).toLocaleString()}</td>
      <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${qty}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(subtotal).toLocaleString()}</td>
    </tr>`;
  }).join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b></p>
    <p>支払いステータス: <b>${session.payment_status}</b></p>
    <p>購入者メール: <b>${buyerEmail}</b></p>

    <h3>注文内容</h3>
    <table style="border-collapse:collapse;width:100%;max-width:680px;">
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:2px solid #333;">商品名</th>
          <th style="text-align:right;border-bottom:2px solid #333;">単価（税込）</th>
          <th style="text-align:center;border-bottom:2px solid #333;">数量</th>
          <th style="text-align:right;border-bottom:2px solid #333;">小計</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="margin-top:12px;font-size:16px;">
      合計金額: <b>¥${Math.round(total).toLocaleString()}</b> (${currency})
    </p>

    <h3>お届け先</h3>
    <p>
      氏名：${name}<br/>
      電話：${phone}<br/>
      住所：${addressLine || "-"}
    </p>

    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">このメールは Stripe Webhook により自動送信されています。</p>
  </div>`;
}

// ===== 送信ログを Firestore に必ず記録（成功/失敗/原因）=====
function safeErr(e: any) {
  try {
    if (!e) return null;
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e).slice(0, 2000);
  } catch {
    return String(e);
  }
}
async function recordOrderMail(params: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string;
  eventType: string;
  connectedAccountId?: string | null;
  sent: boolean;
  reason?: string | null;
  extra?: Record<string, any>;
  htmlPreview?: string | null;
}) {
  try {
    const { FieldValue } = await import("firebase-admin/firestore");
    const payload = {
      siteKey: params.siteKey,
      ownerEmail: params.ownerEmail,
      sessionId: params.sessionId,
      eventType: params.eventType,
      connectedAccountId: params.connectedAccountId ?? null,
      sent: params.sent,
      reason: params.reason ?? null,
      extra: params.extra ?? null,
      htmlPreview: params.htmlPreview ? params.htmlPreview.slice(0, 50000) : null,
      createdAt: FieldValue.serverTimestamp(),
    };
    await adminDb.collection("orderMails").add(payload);
  } catch (e) {
    console.error("orderMails logging failed:", e);
  }
}

// ===== Webhook 本体 =====
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("No signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err) {
    console.error("❌ Invalid Stripe signature:", err);
    return new NextResponse("Webhook Error", { status: 400 });
  }

  // Stripe Connect: 接続アカウントID（ある場合）
  const connectedAccountId = (event as any).account as string | undefined;
  const requestOpts: Stripe.RequestOptions | undefined = connectedAccountId
    ? { stripeAccount: connectedAccountId }
    : undefined;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session & {
          metadata?: { siteKey?: string };
          shipping_details?: ShippingDetails;
        };

        // --- siteKey 解決 ---
        const siteKey =
          session.metadata?.siteKey ||
          (session.customer ? await getSiteKeyByCustomerId(session.customer as string) : null) ||
          (session.client_reference_id ?? null);

        console.log("🔎 siteKey resolved:", {
          siteKey,
          from: session.metadata?.siteKey ? "metadata" : session.customer ? "customer->Firestore" : "client_reference_id or unresolved",
          sessionId: session.id,
          connectedAccountId,
        });

        if (!siteKey) {
          await recordOrderMail({
            siteKey: null,
            ownerEmail: null,
            sessionId: session.id,
            eventType: event.type,
            connectedAccountId,
            sent: false,
            reason: "siteKey unresolved (metadata/customer/client_reference_id none)",
            extra: { hasCustomer: !!session.customer, metadata: session.metadata ?? null },
          });
          break;
        }

        // --- Firestore 更新（顧客ID保存/状態更新）---
        try {
          await adminDb.doc(`siteSettings/${siteKey}`).set(
            { stripeCustomerId: session.customer ?? undefined, subscriptionStatus: "active" },
            { merge: true }
          );
        } catch (e) {
          console.error("Firestore siteSettings update failed:", e);
          // 続行はする（メール送信には ownerEmail が必要だが、siteKey は既にある）
        }

        // --- Line Items を Connect 文脈で取得（重要）---
        let lineItems: Stripe.ApiList<Stripe.LineItem>;
        try {
          lineItems = await stripe.checkout.sessions.listLineItems(
            session.id,
            { expand: ["data.price.product"], limit: 100 },
            requestOpts
          );
        } catch (e) {
          const reason = `listLineItems failed: ${safeErr(e)}`;
          console.error(reason);
          await recordOrderMail({
            siteKey,
            ownerEmail: null,
            sessionId: session.id,
            eventType: event.type,
            connectedAccountId,
            sent: false,
            reason,
          });
          break;
        }

        // --- ownerEmail 取得 ---
        const ownerEmail = await getOwnerEmailBySiteKey(siteKey);
        if (!ownerEmail) {
          const reason = `ownerEmail not found at siteSettings/${siteKey}`;
          console.warn(reason);
          await recordOrderMail({
            siteKey,
            ownerEmail: null,
            sessionId: session.id,
            eventType: event.type,
            connectedAccountId,
            sent: false,
            reason,
          });
          break;
        }

        // --- メール作成 & 送信 ---
        const html = buildOrderHtml(session, lineItems);

        try {
          await sendMail({ to: ownerEmail, subject: "【注文通知】新しい注文が完了しました", html });
          console.log("📧 Sent order email to:", ownerEmail);
          await recordOrderMail({
            siteKey,
            ownerEmail,
            sessionId: session.id,
            eventType: event.type,
            connectedAccountId,
            sent: true,
            htmlPreview: html,
          });
        } catch (mailErr) {
          const reason = `sendMail failed: ${safeErr(mailErr)}`;
          console.error(reason);
          await recordOrderMail({
            siteKey,
            ownerEmail,
            sessionId: session.id,
            eventType: event.type,
            connectedAccountId,
            sent: false,
            reason,
            htmlPreview: html,
          });
        }

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey) {
          await adminDb.doc(`siteSettings/${siteKey}`).update({ subscriptionStatus: "active" });
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey) {
          await adminDb.doc(`siteSettings/${siteKey}`).update({ subscriptionStatus: "unpaid" });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const siteKey = await getSiteKeyByCustomerId(sub.customer as string);
        if (siteKey) {
          await adminDb.doc(`siteSettings/${siteKey}`).update({ subscriptionStatus: "canceled" });
          await deleteVercelProject(siteKey);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    const reason = safeErr(err);
    console.error("🔥 Webhook handler error:", reason);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
