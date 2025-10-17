// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb } from "@/lib/firebase-admin";
import { stripe } from "@/lib/stripe";
import { sendMail } from "@/lib/mailer";

// === Next.js App Router 用 ===
export const runtime = "nodejs";

// === Stripe 設定 ===
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const vercelToken = process.env.VERCEL_TOKEN!;

// ================================
// 🔧 型補助（Stripe SDKに含まれない shipping_details 用）
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
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const toMajor = (amount: number | null | undefined, currency?: string | null) => {
  const a = amount ?? 0;
  const c = (currency ?? "jpy").toLowerCase();
  return ZERO_DECIMAL.has(c) ? a : a / 100;
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
  return !snap.empty ? snap.docs[0].id : null;
}

async function getOwnerEmailBySiteKey(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

// ================================
// 🔧 Vercel プロジェクト削除
// ================================
async function deleteVercelProject(siteKey: string) {
  try {
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
  } catch (err) {
    console.error("deleteVercelProject error:", err);
  }
}

// ================================
// 🔧 注文メールHTML生成
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
      const product = li.price?.product as Stripe.Product | undefined;
      const pname = product?.name || li.description || "商品";
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
    <p style="color:#666;font-size:12px;">
      このメールは Stripe Webhook により自動送信されています。
    </p>
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
    console.error("❌ Invalid Stripe signature:", err);
    return new NextResponse("Webhook Error", { status: 400 });
  }

  try {
    switch (event.type) {
      // ============================
      // ✅ 支払い完了イベント
      // ============================
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session & {
          metadata?: { siteKey?: string };
          shipping_details?: ShippingDetails;
        };

        // --- siteKey 判定 ---
        const siteKey =
          session.metadata?.siteKey ||
          (session.customer
            ? await getSiteKeyByCustomerId(session.customer as string)
            : null);

        console.log("🔎 Resolved siteKey:", siteKey);

        if (!siteKey) {
          console.warn("⚠️ No siteKey found for session:", session.id);
          break;
        }

        // --- Firestore 更新 ---
        await adminDb.doc(`siteSettings/${siteKey}`).set(
          {
            stripeCustomerId: session.customer ?? undefined,
            subscriptionStatus: "active",
          },
          { merge: true }
        );

        // --- 商品リスト取得 ---
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
          expand: ["data.price.product"],
        });

        // --- メール送信 ---
        const ownerEmail = await getOwnerEmailBySiteKey(siteKey);
        if (ownerEmail) {
          const html = buildOrderHtml(session, lineItems);
          try {
            await sendMail({
              to: ownerEmail,
              subject: "【注文通知】新しい注文が完了しました",
              html,
            });
            console.log("📧 Sent order email to:", ownerEmail);
          } catch (mailErr) {
            console.error("📨 Mail send failed:", mailErr);
          }
        } else {
          console.warn(`⚠️ ownerEmail not found in siteSettings/${siteKey}`);
        }

        break;
      }

      // ============================
      // 🟢 支払い成功（定期）
      // ============================
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey) {
          await adminDb
            .doc(`siteSettings/${siteKey}`)
            .update({ subscriptionStatus: "active" });
        }
        break;
      }

      // ============================
      // 🔴 支払い失敗
      // ============================
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const siteKey = await getSiteKeyByCustomerId(invoice.customer as string);
        if (siteKey) {
          await adminDb
            .doc(`siteSettings/${siteKey}`)
            .update({ subscriptionStatus: "unpaid" });
        }
        break;
      }

      // ============================
      // ⚫ サブスクリプション削除
      // ============================
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const siteKey = await getSiteKeyByCustomerId(sub.customer as string);
        if (siteKey) {
          await adminDb
            .doc(`siteSettings/${siteKey}`)
            .update({ subscriptionStatus: "canceled" });
          await deleteVercelProject(siteKey);
        }
        break;
      }

      // ============================
      // その他イベント
      // ============================
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    console.error("🔥 Webhook handler error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
