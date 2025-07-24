// src/app/api/check-subscription/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(req: NextRequest) {
  const siteKey = req.nextUrl.searchParams.get("siteKey");
  console.log("📡 check-subscription START", siteKey);

  if (!siteKey) {
    console.warn("⚠️ siteKey が未指定です");
    return NextResponse.json({ status: "none" }, { status: 400 });
  }

  try {
    const snap = await adminDb.doc(`siteSettings/${siteKey}`).get();

    if (!snap.exists) {
      console.warn("⚠️ 該当のドキュメントが存在しません:", siteKey);
      return NextResponse.json({ status: "none" });
    }

    const data = snap.data() ?? {};
    const customerId = data.stripeCustomerId as string | undefined;
    const isFreePlan = data.isFreePlan !== false;

    if (isFreePlan || !customerId) {
      console.log("✅ 無料プランまたは stripeCustomerId 不在");
      return NextResponse.json({ status: "none" });
    }

    console.log("🔍 Stripe Customer ID:", customerId);

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 5,
    });

    const hasActive = subs.data.some((s) =>
      ["active", "trialing"].includes(s.status)
    );
    const hasCanceled = subs.data.some((s) => s.status === "canceled");

    const status = hasActive ? "active" : hasCanceled ? "canceled" : "none";
    console.log("✅ 判定結果:", status);

    return NextResponse.json({ status });
  } catch (err) {
    console.error("❌ check-subscription エラー:", err);
    return new NextResponse("Server Error", { status: 500 });
  }
}
