// src/app/api/stripe/create-checkout-session-connect/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { stripeConnect } from "@/lib/stripe-connect";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function getAdminDb() {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getFirestore();
}

async function resolveSeller(db: FirebaseFirestore.Firestore, sellerId: string, siteKey?: string) {
  let snap = await db.collection("siteSellers").doc(sellerId).get();
  const keyToFind = siteKey || sellerId;
  if (!snap.exists && keyToFind) {
    const q = await db.collection("siteSellers").where("siteKey", "==", keyToFind).limit(1).get();
    if (!q.empty) snap = q.docs[0];
  }
  return snap;
}

type CartItem = { name: string; unitAmount: number; qty: number };

export async function POST(req: Request) {
  const step = "[checkout-connect]";
  const t0 = Date.now();

  try {
    const { sellerId, siteKey, items, platformFee = 0 } =
      (await req.json()) as {
        sellerId: string;
        siteKey?: string;
        items: CartItem[];
        platformFee?: number; // 合計から徴収したい手数料(円)
      };

    if (!sellerId) return NextResponse.json({ error: "sellerId required", step }, { status: 400 });
    if (!Array.isArray(items) || items.length === 0)
      return NextResponse.json({ error: "items empty", step }, { status: 400 });

    const baseUrl =
      process.env.BASE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000";

    const db = getAdminDb();
    const sellerSnap = await resolveSeller(db, sellerId, siteKey);
    if (!sellerSnap.exists) return NextResponse.json({ error: "seller not found", step }, { status: 404 });

    const seller = sellerSnap.data() || {};
    const accountId: string | null = seller?.stripe?.connectAccountId ?? null;
    if (!accountId) return NextResponse.json({ error: "connect account missing", step }, { status: 400 });

    // line_items を Stripe 形式に変換
    const line_items = items.map((it) => ({
      price_data: {
        currency: "jpy",
        product_data: { name: it.name },
        unit_amount: Math.max(0, Math.round(it.unitAmount)), // 円
      },
      quantity: Math.max(1, Math.round(it.qty)),
    }));

    // プラットフォーム手数料（application_fee_amount）は合計ベース
    const amountSubtotal = items.reduce((s, it) => s + it.unitAmount * it.qty, 0);
    const applicationFee = Math.max(0, Math.min(amountSubtotal, Math.round(platformFee)));

    const session = await stripeConnect.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      payment_intent_data: {
        application_fee_amount: applicationFee,
        transfer_data: { destination: accountId },
      },
      success_url: `${baseUrl}/productsEC/checkout_success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/productsEC/checkout_cancel`,
      metadata: {
        sellerDocId: sellerSnap.id,
        siteKey: seller.siteKey ?? siteKey ?? "",
      },
    });

    // 任意：プレオーダー記録（未確定）
    await db.collection("siteOrders").add({
      sellerDocId: sellerSnap.id,
      siteKey: seller.siteKey ?? siteKey ?? null,
      status: "created",
      checkoutSessionId: session.id,
      items,
      applicationFee,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    console.error(step, "failed:", e?.message || e);
    return NextResponse.json({ error: e?.message || "failed", step }, { status: 500 });
  } finally {
    console.log("[checkout-connect] done in", Date.now() - t0, "ms");
  }
}
