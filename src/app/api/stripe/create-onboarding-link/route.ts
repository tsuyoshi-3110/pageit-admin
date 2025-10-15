// app/api/stripe/create-onboarding-link/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { stripeConnect } from "@/lib/stripe-connect";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function getAdminDb() {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";

    // .envで両端に"が付いている/ \n エスケープを実改行へ
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Admin env not configured");
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getFirestore();
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let step = "[create-onboarding-link]";

  try {
    step = "[request] parse";
    const { sellerId, siteKey } = await req.json();
    if (!sellerId) {
      return NextResponse.json(
        { error: "sellerId required", step },
        { status: 400 }
      );
    }
    if (!process.env.STRIPE_CONNECT_SECRET_KEY) {
      return NextResponse.json(
        { error: "STRIPE_CONNECT_SECRET_KEY not configured", step },
        { status: 500 }
      );
    }

    step = "[env] baseUrl";
    const baseUrl =
      process.env.BASE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000";

    step = "[admin] init";
    const db = getAdminDb();

    step = "[firestore] read seller";
    const sellerRef = db.collection("siteSellers").doc(sellerId);
    let snap = await sellerRef.get();

    step = "[firestore] create-if-missing";
    if (!snap.exists) {
      await sellerRef.set({
        name: "甘味処 よって屋（本店）",
        email: "",
        siteKey: siteKey ?? null,
        stripe: { connectAccountId: null, onboardingCompleted: false },
        fee: { platformPct: 0.0 },
        donationPct: 0.01,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      snap = await sellerRef.get();
    }

    step = "[stripe] ensure account";
    let accountId: string | null = snap.get("stripe")?.connectAccountId ?? null;
    const sellerEmail = snap.get("email") || undefined;

    if (!accountId) {
      const account = await stripeConnect.accounts.create({
        type: "express",
        country: "JP",
        email: sellerEmail,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      await sellerRef.set(
        {
          stripe: { connectAccountId: accountId, onboardingCompleted: false },
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );
    }

    step = "[stripe] account link";
    const link = await stripeConnect.accountLinks.create({
      account: accountId!,
      type: "account_onboarding",
      refresh_url: `${baseUrl}/onboarding/refresh?sellerId=${encodeURIComponent(
        sellerId
      )}`,
      return_url: `${baseUrl}/onboarding/return?sellerId=${encodeURIComponent(
        sellerId
      )}`,
    });

    return NextResponse.json({ url: link.url, step });
  } catch (e: any) {
    console.error(step, "failed:", e?.message || e);
    return NextResponse.json(
      { error: e?.message || "failed to create onboarding link", step },
      { status: 500 }
    );
  } finally {
    console.log("[create-onboarding-link] done in", Date.now() - t0, "ms");
  }
}
