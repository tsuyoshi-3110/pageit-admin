// node実行を強制
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// GET /api/admin/orders/list?siteKey=xxx&from=2025-09-01&to=2025-10-01&limit=50&cursor=...
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const siteKey = searchParams.get("siteKey") || "";
    const from = searchParams.get("from"); // YYYY-MM-DD
    const to   = searchParams.get("to");   // YYYY-MM-DD (exclusive 推奨)
    const limit = Math.min(Number(searchParams.get("limit") || 50), 200);
    const cursor = searchParams.get("cursor"); // createdAt の数値を想定

    if (!siteKey) {
      return NextResponse.json({ error: "siteKey is required" }, { status: 400 });
    }

    let q: FirebaseFirestore.Query = adminDb.collection("orders")
      .where("siteKey", "==", siteKey)
      .orderBy("createdAt", "desc")
      .limit(limit);

    if (from) {
      const fromTs = Date.parse(from);
      if (!Number.isNaN(fromTs)) q = q.where("createdAt", ">=", fromTs);
    }
    if (to) {
      const toTs = Date.parse(to);
      if (!Number.isNaN(toTs)) q = q.where("createdAt", "<", toTs);
    }
    if (cursor) {
      const after = Number(cursor);
      if (!Number.isNaN(after)) q = q.startAfter(after);
    }

    const snap = await q.get();
    const items = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    const nextCursor = snap.docs.length ? String(snap.docs[snap.docs.length - 1]?.get("createdAt") || "") : "";

    // 合計などのサマリ（このページ分）
    const pageTotal = items.reduce((s, x: any) => s + (Number(x.amountTotal)||0), 0);

    return NextResponse.json({ items, nextCursor, pageTotal });
  } catch (e) {
    console.error("[orders.list] error:", e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
