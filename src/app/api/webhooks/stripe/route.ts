import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebase-admin";
import { stripe } from "@/lib/stripe";
import { sendMail } from "@/lib/mailer";

export const config = {
  api: { bodyParser: false },
};

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const vercelToken = process.env.VERCEL_TOKEN!;

// ================================
// 🔧 型補助（Stripe SDK にない shipping_details 用）
// ================================
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

// ================================
// 🔧 通貨ヘルパー
// ================================
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
  "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

const toMajor = (amount: number | null | undefined, currency?: string | null) => {
  const a = amount ?? 0;
  const c = currency ?? "jpy";
  return ZERO_DECIMAL.has(c.toLowerCase()) ? a : a / 100;
};

// ================================
// 🔧 Firestore補助
// ================================
async function getSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0].id;
  return null;
}

async function getOwnerEmailBySiteKey(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

// ================================
// 🔧 Vercelプロジェクト削除
// ================================
async function deleteVercelProject(siteKey: string) {
  const res = await fetch(`https://api.vercel.com/v9/projects/${siteKey}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Vercel project deletion failed:", err);
  } else {
    console.log(`✅ Deleted Vercel project "${siteKey}"`);
  }
}

// ================================
// 🧾 注文メールHTML生成
// ================================
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
  ]
    .filter(Boolean)
    .join(" ");

  const buyerEmail =
    session.customer_details?.email || session.customer_email || "-";
  const name = shipping?.name || "-";
  const phone = shipping?.phone || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = lineItems.data
    .map((li) => {
      const pname =
        (li.price?.product as Stripe.Product | undefined)?.name ||
        li.description ||
        "商品";
      const qty = li.quantity || 1;
      const subtotal = toMajor(li.amount_subtotal ?? 0, session.currency);
      const unit = subtotal / qty;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${pname}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(
          unit
        ).toLocaleString()}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">¥${Math.round(
          subtotal
        ).toLocaleString()}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b></p>
    <p>支払いステータス: <b>${session.payment_status}</b></p>
    <p>購入者メール: <b>${buyerEmail}</b></p>

    <h3>注文内容</h3>
    <table style="border-collapse:collapse;width:100%;max-width:640px;">
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

    <p style="margin-top:12px;font-size:16px;">合計金額: <b>¥${Math.round(
      total
    ).toLocaleString()}</b> (${currency})</p>

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

// ================================
// 🔧 Webhook 本体
// ================================
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("No signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err) {
    console.error("Invalid signature:", err);
    return new NextResponse("Webhook Error", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session & {
          metadata?: { siteKey?: string };
          shipping_details?: ShippingDetails;
        };
        const siteKey =
          session.metadata?.siteKey ||
          (session.customer
            ? await getSiteKeyByCustomerId(session.customer as string)
            : null);
        if (!siteKey) {
          console.warn("No siteKey found");
          break;
        }

        await adminDb.doc(`siteSettings/${siteKey}`).set(
          {
            stripeCustomerId: session.customer ?? undefined,
            subscriptionStatus: "active",
          },
          { merge: true }
        );

        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
          expand: ["data.price.product"],
        });

        const ownerEmail = await getOwnerEmailBySiteKey(siteKey);
        if (ownerEmail) {
          const html = buildOrderHtml(session, lineItems);
          await sendMail({
            to: ownerEmail,
            subject: "【注文通知】新しい注文が完了しました",
            html,
          });
          console.log("📧 Sent order email to", ownerEmail);
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey)
          await adminDb.doc(`siteSettings/${siteKey}`).update({ subscriptionStatus: "active" });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey)
          await adminDb.doc(`siteSettings/${siteKey}`).update({ subscriptionStatus: "unpaid" });
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
    console.error("Webhook error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
