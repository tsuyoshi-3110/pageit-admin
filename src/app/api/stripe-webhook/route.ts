// src/app/api/stripe-webhook/route.ts
import Stripe from "stripe";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

// ★ nodemailer / firebase-admin を使うので Node.js を強制
export const runtime = "nodejs";
// ★ キャッシュさせない（デバッグ時の混乱回避）
export const dynamic = "force-dynamic";

// ---- Stripe ----
const stripeWH = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// ---- siteKey の最終決定ロジック（クライアント atom は使わない）----
// 1) Checkout metadata.siteKey
// 2) 環境変数 SITE_KEY
// 3) 既定値 "kikaikintots"
function resolveSiteKey(metaSiteKey?: string | null): string {
  return (metaSiteKey && String(metaSiteKey)) || process.env.SITE_KEY || "kikaikintots";
}

export async function POST(req: Request) {
  // Stripe の署名検証は "生の body" が必要
  const body = await req.text();
  const sig = (await headers()).get("stripe-signature");

  // 受信直後のログ
  console.log("[stripe-webhook] received:", {
    hasSig: !!sig,
    bodyLen: body?.length ?? 0,
    ts: Date.now(),
    nodeEnv: process.env.NODE_ENV,
    runtime: "nodejs",
  });

  let event: Stripe.Event;
  try {
    event = stripeWH.webhooks.constructEvent(body, sig!, endpointSecret);
  } catch (e) {
    console.error("[stripe-webhook] ✗ bad signature / constructEvent failed:", e);
    return new NextResponse("Bad signature", { status: 400 });
  }

  // イベントの基本情報
  console.log("[stripe-webhook] event:", {
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
  });

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // セッション情報ログ（個人情報を出し過ぎない範囲で）
      console.log("[stripe-webhook] session.summary:", {
        id: session.id,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_details: {
          has: !!session.customer_details,
          name: session.customer_details?.name ? true : false,
          email: session.customer_details?.email ? true : false,
          phone: session.customer_details?.phone ? true : false,
          address_exists: !!session.customer_details?.address,
        },
        metadata: session.metadata || {},
      });

      // ---- 冪等性チェック（同じイベントIDでは2回送らない）----
      const sentRef = adminDb.doc(`orderMails/${event.id}`);
      const sentSnap = await sentRef.get();
      if (sentSnap.exists) {
        console.warn("[stripe-webhook] duplicated event, skip mail:", event.id);
        return NextResponse.json({ ok: true, dedup: true });
      }

      // ---- ラインアイテム ----
      let lineItems: Stripe.ApiList<Stripe.LineItem>;
      try {
        lineItems = await stripeWH.checkout.sessions.listLineItems(session.id);
        console.log("[stripe-webhook] lineItems.count:", lineItems.data.length);
      } catch (e) {
        console.error("[stripe-webhook] ✗ listLineItems failed:", e);
        throw e;
      }

      // ---- 注文モデル作成 ----
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
        currency: (session.currency || "jpy") as string,
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

      // ---- Firestore保存（orders/{session.id}）----
      try {
        await adminDb.collection("orders").doc(session.id).set(order, { merge: true });
        console.log("[stripe-webhook] order saved:", {
          docPath: `orders/${session.id}`,
          siteKey,
          amountTotal: order.amountTotal,
        });
      } catch (e) {
        console.error("[stripe-webhook] ✗ save order failed:", e);
        throw e;
      }

      // ---- 通知先メールアドレスをFirestoreから取得 ----
      let ownerEmail = "";
      try {
        const settingsRef = adminDb.doc(`siteSettings/${siteKey}`);
        const settingsSnap = await settingsRef.get();
        const settingsData = settingsSnap.data() || {};
        ownerEmail = (settingsData.ownerEmail || "").trim();

        console.log("[stripe-webhook] settings lookup:", {
          path: `siteSettings/${siteKey}`,
          exists: settingsSnap.exists,
          keys: Object.keys(settingsData),
          ownerEmailMasked: ownerEmail ? maskEmail(ownerEmail) : "",
        });
      } catch (e) {
        console.error("[stripe-webhook] ✗ fetch siteSettings failed:", e);
        throw e;
      }

      // ---- メール送信 ----
      if (!ownerEmail) {
        console.warn(
          `[stripe-webhook] ownerEmail not set at siteSettings/${siteKey} (メール送信スキップ)`
        );
      } else {
        try {
          const subject = `【新規注文】${order.customer.name || "お客様"} / 合計 ¥${order.amountTotal.toLocaleString(
            "ja-JP"
          )}`;

          console.log("[stripe-webhook] mail.send start:", {
            to: maskEmail(ownerEmail),
            subject,
            replyToMasked: order.customer.email ? maskEmail(order.customer.email) : undefined,
          });

          await sendMail({
            to: ownerEmail,
            subject,
            html: renderOwnerHtml(order),
            replyTo: order.customer.email || undefined,
          });

          console.log("[stripe-webhook] mail.send done");
        } catch (e) {
          console.error("[stripe-webhook] ✗ mailer failed:", e);
          // 送信失敗は Stripe にリトライしてほしい場合は 500 を返す
          throw e;
        }
      }

      // ---- 送信記録（冪等トークン）----
      try {
        await sentRef.set({ orderId: session.id, createdAt: Date.now() });
        console.log("[stripe-webhook] dedup token saved:", { docPath: `orderMails/${event.id}` });
      } catch (e) {
        console.error("[stripe-webhook] ✗ save dedup token failed:", e);
        // ここで throw しても良いが、注文自体は作られているので 200 返しても可
        throw e;
      }
    } else {
      // それ以外のイベントも見えるように
      console.log("[stripe-webhook] skipped event:", event.type);
    }

    // ここまで来たら成功
    return new NextResponse("ok", { status: 200 });
  } catch (e) {
    console.error("[stripe-webhook] ✗ unhandled error:", e);
    // Stripe にリトライしてほしいので 500
    return new NextResponse("hook error", { status: 500 });
  }
}

/* ========== ユーティリティ / メールHTML ========== */

function maskEmail(e: string) {
  const [name, domain] = String(e).split("@");
  if (!domain) return "***";
  const n = name.length <= 2 ? name[0] + "*" : name[0] + "*".repeat(name.length - 2) + name.slice(-1);
  return `${n}@${domain}`;
}

function yen(n: number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

function renderItemsTable(order: any) {
  const rows = order.lineItems
    .map(
      (it: any) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(it.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${it.qty}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${yen(it.unit)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;" align="right">${yen(it.subtotal)}</td>
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

      <h3 style="margin:16px 0 8px">顧客情報</h3>
      <div style="line-height:1.7">${lines || "（情報なし）"}</div>

      <h3 style="margin:16px 0 8px">ご注文内容</h3>
      ${renderItemsTable(order)}

      <p style="margin-top:12px;font-weight:bold">合計：${yen(order.amountTotal)}</p>

      <p style="margin-top:16px;color:#666">
        受注ID：${escapeHtml(order.stripe.checkoutSessionId)}<br/>
        受信時刻：${new Date(order.createdAt).toLocaleString("ja-JP")}
      </p>
    </div>
  `;
}

function escapeHtml(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
