// src/app/api/resume-subscription/route.ts
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { siteKey } = await req.json();
  if (!siteKey) return NextResponse.json({ error: "siteKey required" }, { status: 400 });

  const snap = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const customerId = snap.data()?.stripeCustomerId;
  if (!customerId) return NextResponse.json({ error: "customer not found" }, { status: 404 });

  const sub = (
    await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    })
  ).data[0];
  if (!sub) return NextResponse.json({ error: "no active sub" }, { status: 404 });

  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });

  await adminDb.doc(`siteSettings/${siteKey}`).set(
    { cancelPending: false, subscriptionStatus: "active", updatedAt: new Date() },
    { merge: true }
  );

  return NextResponse.json({ success: true });
}
