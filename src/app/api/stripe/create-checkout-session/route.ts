import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";

export async function POST(req: Request) {
  try {
    const { siteKey } = await req.json();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not defined");

    const docRef = adminDb.doc(`siteSettings/${siteKey}`);
    const snap = await docRef.get();

    if (!snap.exists) {
      return NextResponse.json(
        { error: "サイト情報が存在しません" },
        { status: 404 }
      );
    }

    const data = snap.data();
    const customerId = data?.stripeCustomerId;

    if (!customerId || typeof customerId !== "string") {
      return NextResponse.json(
        { error: "有効な stripeCustomerId が存在しません" },
        { status: 400 }
      );
    }

    const existingSubs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });

    const activeSub = existingSubs.data.find(
      (sub) => sub.status === "active" || sub.status === "trialing"
    );

    if (activeSub) {
      return NextResponse.json({
        message: "既に有効なサブスクリプションがあります",
        subscriptionId: activeSub.id,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: process.env.STRIPE_DEFAULT_PRICE_ID!,
          quantity: 1,
        },
      ],
      metadata: { siteKey },
      success_url: `${appUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/cancel`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Checkout セッションエラー:", err);
    return new NextResponse("Stripe セッション作成失敗", { status: 500 });
  }
}
