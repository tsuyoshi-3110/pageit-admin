// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { stripeConnect } from "@/lib/stripe-connect";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function db() {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) privateKey = privateKey.slice(1, -1);
    privateKey = privateKey.replace(/\\n/g, "\n");
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getFirestore();
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature") || "";
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET missing" }, { status: 500 });

  const buf = await req.arrayBuffer();
  let event;

  try {
    event = stripeConnect.webhooks.constructEvent(Buffer.from(buf), sig, whSecret);
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err.message);
    return new NextResponse(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // 成功時ハンドリング
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;

    // metadata から参照
    const sellerDocId = session.metadata?.sellerDocId ?? null;
    const siteKey = session.metadata?.siteKey ?? null;

    const d = db();
    // 既存プレオーダーを確定更新（無ければ新規）
    const q = await d.collection("siteOrders").where("checkoutSessionId", "==", session.id).limit(1).get();
    const order = {
      status: "paid",
      amount_total: session.amount_total ?? null,
      currency: session.currency ?? "jpy",
      customer_email: session.customer_details?.email ?? null,
      payment_intent: session.payment_intent ?? null,
      sellerDocId,
      siteKey,
      updatedAt: Timestamp.now(),
    };

    if (!q.empty) {
      await q.docs[0].ref.set(order, { merge: true });
    } else {
      await d.collection("siteOrders").add({
        ...order,
        createdAt: Timestamp.now(),
        checkoutSessionId: session.id,
        items: [], // 必要なら line items API で再取得して保存
      });
    }
  }

  return NextResponse.json({ received: true });
}
