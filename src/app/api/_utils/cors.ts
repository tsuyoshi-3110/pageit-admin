// src/app/api/_utils/cors.ts
import { adminDb } from "@/lib/firebase-admin";
import { NextRequest, NextResponse } from "next/server";

/** Firestore上に登録された許可ドメインを参照し、CORSを動的に判定 */
export async function withDynamicCORS(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin");
  if (!origin) return res;

  try {
    // siteSettings コレクションから origin 一致するドメインを探す
    const sitesSnap = await adminDb
      .collection("siteSettings")
      .where("domain", "==", origin)
      .limit(1)
      .get();

    // Firestore登録済み or localhost の場合のみ許可
    if (!sitesSnap.empty || origin.startsWith("http://localhost:3000")) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Vary", "Origin");
    }
  } catch (e) {
    console.warn("CORS動的判定エラー:", e);
  }

  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}
