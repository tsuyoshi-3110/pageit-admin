// app/api/refunds/route.ts
import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { stripe } from "@/lib/stripe";
/**
 * body: {
 *   orderId: string;
 *   siteKey: string;
 *   paymentIntentId: string;
 *   amount?: number; // JPY（最小単位）
 * }
 * headers.Authorization: Bearer <FirebaseIDToken>
 */
export async function POST(req: Request) {
  try {
    // ---- 認証（Firebase ID トークン）----
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const adminSnap = await adminDb.doc(`admins/${decoded.uid}`).get();
    if (!adminSnap.exists) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ---- 入力 ----
    const { orderId, siteKey, paymentIntentId, amount } = await req.json();

    if (!orderId || !siteKey || !paymentIntentId) {
      return NextResponse.json(
        { error: "Missing orderId/siteKey/paymentIntentId" },
        { status: 400 }
      );
    }
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    // ---- 注文の実在確認（サーバー側で念のため）----
    const orderRef = adminDb.doc(`siteOrders/${orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    const order = orderSnap.data() || {};
    if (order.siteKey !== siteKey) {
      return NextResponse.json({ error: "Site mismatch" }, { status: 400 });
    }
    if (order.refunded === true) {
      return NextResponse.json({ error: "Already refunded" }, { status: 409 });
    }

    const totalAmount: number = Number(order.amount || 0);
    const refundAmount = amount ?? totalAmount;

    if (!Number.isInteger(totalAmount) || refundAmount > totalAmount) {
      return NextResponse.json(
        { error: "Refund exceeds original amount" },
        { status: 400 }
      );
    }

    // ---- Stripe 返金（冪等キーで二重防止）----
    const idempotencyKey = `refund_${orderId}_${refundAmount}`;
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: refundAmount, // JPY は最小単位 = 円
      },
      { idempotencyKey }
    );

    // ---- Firestore 更新（サーバー側で確定記録）----
    await orderRef.update({
      status: "refunded",
      refunded: true,
      refundId: refund.id,
      refundAt: new Date(),
      refundAmount: refundAmount,
    });

    return NextResponse.json({ success: true, refund });
  } catch (err: any) {
    console.error("Refund API error:", err);
    const msg = typeof err?.message === "string" ? err.message : "Server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
