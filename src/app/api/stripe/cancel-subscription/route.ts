// src/app/api/admin/cancel-subscription/route.ts
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { siteKey } = await req.json();
    if (!siteKey) {
      return NextResponse.json(
        { error: "siteKey is required" },
        { status: 400 }
      );
    }

    /* ── Firestore ───────────────────────── */
    const snap = await adminDb.doc(`siteSettings/${siteKey}`).get();
    const data = snap.data() ?? {};
    const customerId = data.stripeCustomerId as string | undefined;
    const isFreePlan = data.isFreePlan !== false; 

    /* ── 無料プラン → 何もしないで成功 ── */
    if (isFreePlan || !customerId) {
      await adminDb
        .doc(`siteSettings/${siteKey}`)
        .set({ cancelPending: false }, { merge: true });
      return NextResponse.json({ success: true, message: "Free plan" });
    }

    /* ── アクティブなサブスクを取得 ──────── */
    const activeSub = (
      await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
      })
    ).data[0];

    if (!activeSub) {
      return NextResponse.json({ success: true, message: "No active sub" });
    }

    /* 既に予約中なら何もしない */
    if (activeSub.cancel_at_period_end) {
      return NextResponse.json({ success: true, message: "Already pending" });
    }

    /* ── 今期終了でキャンセル予約 ─────────── */
    await stripe.subscriptions.update(activeSub.id, {
      cancel_at_period_end: true,
    });

    await adminDb.doc(`siteSettings/${siteKey}`).set(
      {
        cancelPending: true,
        subscriptionStatus: "active", // 課金中＋予約
        updatedAt: new Date(),
      },
      { merge: true }
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("cancel-subscription error:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
