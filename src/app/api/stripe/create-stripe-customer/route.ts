import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";



export async function POST(req: Request) {
  try {
    const { email, name, metadata } = await req.json();

    // Stripe Customer 作成
    const customer = await stripe.customers.create({
      email,
      name,
      metadata,
    });

    // サブスクリプションを作成（定額料金を設定済みの priceId を使う）
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_DEFAULT_PRICE_ID as string }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    });

    return NextResponse.json({
      customerId: customer.id,
      subscriptionId: subscription.id,
    });
  } catch (error: any) {
    console.error("[Stripe Error]", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
