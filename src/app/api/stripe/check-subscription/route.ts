// src/app/api/check-subscription/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UiPaymentStatus =
  | "active"
  | "pending_cancel"
  | "canceled"
  | "none"
  | "past_due"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

function normalizeFromSubs(subs: Stripe.Subscription[]): UiPaymentStatus {
  if (!subs.length) return "none";

  // 最新っぽい順に（created/updated 的に）軽く並べ替え
  const data = [...subs].sort((a, b) => (b.created || 0) - (a.created || 0));

  // 優先順位で判定
  if (
    data.some(
      (s) =>
        (s.status === "active" || s.status === "trialing") &&
        s.cancel_at_period_end
    )
  ) {
    return "pending_cancel";
  }
  if (data.some((s) => s.status === "active" || s.status === "trialing"))
    return "active";
  if (data.some((s) => s.status === "past_due")) return "past_due";
  if (data.some((s) => s.status === "incomplete")) return "incomplete";
  if (data.some((s) => s.status === "incomplete_expired"))
    return "incomplete_expired";
  if (data.some((s) => s.status === "unpaid")) return "unpaid";
  if (data.some((s) => s.status === "canceled")) return "canceled";
  return "none";
}

async function listSubsByCustomer(customerId: string) {
  const res = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  return res.data;
}

async function findCustomerIdByEmail(email?: string | null) {
  if (!email) return null;
  try {
    const r = await stripe.customers.search({
      query: `email:"${email.replace(/"/g, '\\"')}"`,
      limit: 1,
    });
    return r.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const siteKey = searchParams.get("siteKey");
  const fix = searchParams.get("fix") === "1"; // true で自己修復を許可

  if (!siteKey) {
    return NextResponse.json(
      { status: "none", reason: "siteKey required" },
      { status: 400 }
    );
  }

  try {
    const snap = await adminDb.doc(`siteSettings/${siteKey}`).get();
    if (!snap.exists) {
      return NextResponse.json({ status: "none", reason: "site not found" });
    }

    const data = snap.data() ?? {};
    const isFreePlan = data.isFreePlan !== false;
    const customerId: string | null =
      (data.stripeCustomerId as string | null) ?? null;
    const ownerEmail: string | null = data.ownerEmail ?? null;

    if (isFreePlan) {
      return NextResponse.json({ status: "none", reason: "free_plan" });
    }

    // 1) まず保存済み customerId で試行
    if (customerId) {
      try {
        const subs = await listSubsByCustomer(customerId);
        return NextResponse.json({
          status: normalizeFromSubs(subs),
          customerId,
        });
      } catch (e: any) {
        // 代表的な「No such customer」は握りつぶして後続へ
        const code = e?.code || e?.raw?.code;
        if (code !== "resource_missing") {
          // 他エラーは 200 + none にフォールバック（UI を壊さない）
          return NextResponse.json({
            status: "none",
            customerId,
            reason: `stripe:${code || "error"}`,
          });
        }
        // ここでメール検索へフォールバック
      }
    }

    // 2) 保存 ID が無い/壊れている → メールから検索
    const foundId = await findCustomerIdByEmail(ownerEmail);
    if (!foundId) {
      return NextResponse.json({
        status: "none",
        reason: "customer_not_found",
      });
    }

    // fix=1 のときだけ Firestore を自己修復
    if (fix) {
      await adminDb
        .doc(`siteSettings/${siteKey}`)
        .set({ stripeCustomerId: foundId }, { merge: true });
    }

    const subs = await listSubsByCustomer(foundId);
    return NextResponse.json({
      status: normalizeFromSubs(subs),
      customerId: foundId,
      repaired: !!fix,
    });
  } catch (err) {
    // 最後の砦：絶対に 500 は返さない（UI 安定化）
    console.error("check-subscription fatal:", err);
    return NextResponse.json({ status: "none", reason: "unexpected_error" });
  }
}
