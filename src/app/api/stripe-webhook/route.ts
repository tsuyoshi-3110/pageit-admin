// src/app/api/stripe-webhook/route.ts
import Stripe from "stripe";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripeWH = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET2!;

// siteKey 判定ロジック
function resolveSiteKey(metaSiteKey?: string | null): string {
  return (
    (metaSiteKey && String(metaSiteKey)) ||
    process.env.SITE_KEY ||
    "kikaikintots"
  );
}

export async function POST(req: Request) {
  const body = await req.text();
  const sig = (await headers()).get("stripe-signature");

  console.log("[stripe-webhook] received:", {
    hasSig: !!sig,
    bodyLen: body?.length ?? 0,
    ts: Date.now(),
  });

  let event: Stripe.Event;
  try {
    event = stripeWH.webhooks.constructEvent(body, sig!, endpointSecret);
  } catch (e) {
    console.error("[stripe-webhook] ✗ bad signature:", e);
    return new NextResponse("Bad signature", { status: 400 });
  }

  console.log("[stripe-webhook] event:", {
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
  });

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      console.log("[stripe-webhook] session.summary:", {
        id: session.id,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_details: {
          email: !!session.customer_details?.email,
        },
        metadata: session.metadata || {},
      });

      // 冪等性チェック
      const sentRef = adminDb.doc(`orderMails/${event.id}`);
      const sentSnap = await sentRef.get();
      if (sentSnap.exists) {
        console.warn("[stripe-webhook] duplicated event:", event.id);
        return NextResponse.json({ ok: true, dedup: true });
      }

      // ラインアイテム取得
      let lineItems: Stripe.ApiList<Stripe.LineItem>;
      try {
        lineItems = await stripeWH.checkout.sessions.listLineItems(session.id);
      } catch (e) {
        console.error("[stripe-webhook] ✗ listLineItems failed:", e);
        return new NextResponse("hook error", { status: 500 });
      }

      // 注文データ作成
      const siteKey = resolveSiteKey(session.metadata?.siteKey);
      const cd = session.customer_details;
      const addr = cd?.address;

      const items = lineItems.data.map((x) => ({
        name: x.description || "item",
        qty: x.quantity || 1,
        unit: x.price?.unit_amount ?? 0,
        subtotal: (x.price?.unit_amount ?? 0) * (x.quantity || 1),
      }));

      const order = {
        siteKey,
        status: "paid" as const,
        amountTotal: session.amount_total ?? 0,
        currency: session.currency || "jpy",
        customer: {
          name: cd?.name || "",
          email: cd?.email || "",
          phone: cd?.phone || "",
          address: [
            addr?.postal_code,
            addr?.state,
            addr?.city,
            addr?.line1,
            addr?.line2,
          ]
            .filter(Boolean)
            .join(" "),
        },
        lineItems: items,
        stripe: {
          checkoutSessionId: session.id,
          paymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id,
        },
        createdAt: Date.now(),
      };

      // Firestore 保存
      try {
        await adminDb
          .collection("orders")
          .doc(session.id)
          .set(order, { merge: true });
        console.log("[stripe-webhook] order saved:", {
          docPath: `orders/${session.id}`,
          siteKey,
        });
      } catch (e) {
        console.error("[stripe-webhook] ✗ save order failed:", e);
      }

      // ownerEmail 取得
      let ownerEmail = "";
      try {
        const settingsSnap = await adminDb
          .doc(`siteSettings/${siteKey}`)
          .get();
        ownerEmail = (settingsSnap.data()?.ownerEmail || "").trim();
      } catch (e) {
        console.error("[stripe-webhook] ✗ fetch siteSettings failed:", e);
      }

      // メール送信
      if (ownerEmail) {
        const subject = `【新規注文】${
          order.customer.name || "お客様"
        } / 合計 ¥${order.amountTotal.toLocaleString("ja-JP")}`;
        try {
          await sendMail({
            to: ownerEmail,
            subject,
            html: renderOwnerHtml(order),
            replyTo: order.customer.email || undefined,
          });
          console.log("[stripe-webhook] mail.send done");
        } catch (e) {
          console.error("[stripe-webhook] ✗ mailer failed (non-blocking):", e);
          // ここでは throw せず 200 を返す
        }
      } else {
        console.warn(`[stripe-webhook] ownerEmail not set for ${siteKey}`);
      }

      // 冪等トークン保存
      try {
        await sentRef.set({ orderId: session.id, createdAt: Date.now() });
      } catch (e) {
        console.error("[stripe-webhook] ✗ save dedup token failed:", e);
      }
    }

    return new NextResponse("ok", { status: 200 });
  } catch (e) {
    console.error("[stripe-webhook] ✗ unhandled error:", e);
    return new NextResponse("hook error", { status: 500 });
  }
}

/* ========== Utils ========== */
function yen(n: number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

function renderItemsTable(order: any) {
  const rows = order.lineItems
    .map(
      (it: any) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(
          it.name
        )}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${
          it.qty
        }</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${yen(
          it.unit
        )}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${yen(
          it.subtotal
        )}</td>
      </tr>`
    )
    .join("");
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <thead>
        <tr>
          <th align="left" style="padding:6px 8px;border-bottom:2px solid #333;">商品名</th>
          <th align="right" style="padding:6px 8px;border-bottom:2px solid #333;">数量</th>
          <th align="right" style="padding:6px 8px;border-bottom:2px solid #333;">単価</th>
          <th align="right" style="padding:6px 8px;border-bottom:2px solid #333;">小計</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderOwnerHtml(order: any) {
  const lines = [
    order.customer.name,
    order.customer.address,
    order.customer.phone,
    order.customer.email,
  ]
    .filter(Boolean)
    .map((x: string) => escapeHtml(x))
    .join("<br/>");

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,'ヒラギノ角ゴ ProN',Meiryo,sans-serif;font-size:14px;color:#111">
      <p>新しい注文が確定しました。</p>
      <h3>顧客情報</h3>
      <div>${lines || "（情報なし）"}</div>
      <h3>ご注文内容</h3>
      ${renderItemsTable(order)}
      <p style="margin-top:12px;font-weight:bold">合計：${yen(
        order.amountTotal
      )}</p>
      <p style="margin-top:16px;color:#666">
        受注ID：${escapeHtml(
          order.stripe.checkoutSessionId
        )}<br/>受信時刻：${new Date(order.createdAt).toLocaleString("ja-JP")}
      </p>
    </div>
  `;
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
