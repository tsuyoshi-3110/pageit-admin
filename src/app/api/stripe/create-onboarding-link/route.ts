// src/app/api/stripe/create-onboarding-link/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripeConnect } from "@/lib/stripe-connect";
import { adminDb } from "@/lib/firebase-admin";

/* ========= CORS 共通 ========= */
const DEFAULT_ALLOW_LIST = [
  "http://localhost:3000",
  "https://localhost:3000",
  "https://pageit-admin.vercel.app",
  "https://*.pageit.shop", // オーナー本番ワイルドカード。必要に応じ調整 or 環境変数で追加
];

function originAllowed(origin: string | null): string | null {
  if (!origin) return null;
  const extra = (process.env.CORS_ALLOW_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const patterns = [...DEFAULT_ALLOW_LIST, ...extra];

  const ok = patterns.some((pat) => {
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return re.test(origin);
    }
    return pat === origin;
  });
  return ok ? origin : null;
}

function withCORS(req: NextRequest, res: NextResponse) {
  const origin = originAllowed(req.headers.get("origin"));
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

/* ========= Preflight ========= */
export async function OPTIONS(req: NextRequest) {
  return withCORS(req, new NextResponse(null, { status: 204 }));
}

/* ========= 本体 =========
 * 管理サイト側 API:
 * - body: { sellerId: string, siteKey?: string, returnUrl?: string, refreshUrl?: string, successReturnUrl?: string }
 *   - 通常は returnUrl（例: https://owner.example.com）だけ渡せばOK
 *   - refresh/return を完全指定したい場合は refreshUrl/SuccessReturnUrl を個別指定可
 * - Firestore: siteSellers/{sellerId} を作成/更新
 * - Stripe Connect Express アカウント作成 → onboarding link を返す
 * - 任意の Bearer 認証（ADMIN_API_TOKEN 設定時のみ有効）
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let step = "[create-onboarding-link] start";

  try {
    // ---- （任意）Bearer 認証 ----
    const requiredToken = process.env.ADMIN_API_TOKEN;
    if (requiredToken) {
      const auth = req.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== requiredToken) {
        return withCORS(
          req,
          NextResponse.json({ error: "unauthorized" }, { status: 401 })
        );
      }
    }

    step = "[request] parse";
    const {
      sellerId,
      siteKey,
      returnUrl,          // 例: "https://kikaikintots.shop"（末尾スラなし推奨）
      refreshUrl,         // 例: "https://kikaikintots.shop/onboarding/refresh?sellerId=..."
      successReturnUrl,   // 例: "https://kikaikintots.shop/onboarding/return?sellerId=..."
    } = await req.json();

    if (!sellerId) {
      return withCORS(
        req,
        NextResponse.json({ error: "sellerId required", step }, { status: 400 })
      );
    }

    step = "[urls] build";
    // owner 側のベースURL（未指定なら管理側の既定 or エラー）
    const ownerBase =
      typeof returnUrl === "string" && returnUrl.startsWith("http")
        ? returnUrl.replace(/\/+$/, "")
        : (process.env.NEXT_PUBLIC_OWNER_BASE_URL || "").replace(/\/+$/, "");

    if (!refreshUrl && !successReturnUrl && !ownerBase) {
      return withCORS(
        req,
        NextResponse.json(
          { error: "returnUrl (or NEXT_PUBLIC_OWNER_BASE_URL) is required", step },
          { status: 400 }
        )
      );
    }

    const builtRefresh =
      refreshUrl ||
      `${ownerBase}/onboarding/refresh?sellerId=${encodeURIComponent(sellerId)}`;
    const builtReturn =
      successReturnUrl ||
      `${ownerBase}/onboarding/return?sellerId=${encodeURIComponent(sellerId)}`;

    step = "[firestore] ensure seller";
    const sellerRef = adminDb.collection("siteSellers").doc(sellerId);
    let snap = await sellerRef.get();

    if (!snap.exists) {
      await sellerRef.set({
        name: "甘味処 よって屋（本店）",
        email: "",
        siteKey: siteKey ?? null,
        stripe: { connectAccountId: null, onboardingCompleted: false },
        fee: { platformPct: 0.0 },
        donationPct: 0.01,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      snap = await sellerRef.get();
    }

    step = "[stripe] ensure account";
    const seller = snap.data() || {};
    let accountId: string | null = seller?.stripe?.connectAccountId ?? null;
    const sellerEmail: string | undefined =
      (seller?.email && typeof seller.email === "string" && seller.email) || undefined;

    if (!accountId) {
      const account = await stripeConnect.accounts.create({
        type: "express",
        country: "JP",
        email: sellerEmail,
        capabilities: { transfers: { requested: true } },
        // 追加で必要なら business_type / company / individual なども設定可
      });
      accountId = account.id;

      await sellerRef.set(
        {
          stripe: { connectAccountId: accountId, onboardingCompleted: false },
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }

    step = "[stripe] account link";
    const link = await stripeConnect.accountLinks.create({
      account: accountId!,
      type: "account_onboarding",
      refresh_url: builtRefresh,
      return_url: builtReturn,
    });

    return withCORS(
      req,
      NextResponse.json({
        url: link.url,
        accountId,
        step,
        tookMs: Date.now() - t0,
      })
    );
  } catch (e: any) {
    console.error(step, "failed:", e?.message || e);
    return withCORS(
      req,
      NextResponse.json(
        { error: e?.message || "failed to create onboarding link", step },
        { status: 500 }
      )
    );
  }
}
