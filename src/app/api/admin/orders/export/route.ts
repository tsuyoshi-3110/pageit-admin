// src/app/api/admin/orders/export/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const siteKey = searchParams.get("siteKey") || "";
    const from = searchParams.get("from");
    const to   = searchParams.get("to");

    if (!siteKey) return new NextResponse("siteKey required", { status: 400 });

    let q: FirebaseFirestore.Query = adminDb.collection("orders")
      .where("siteKey", "==", siteKey)
      .orderBy("createdAt", "desc");

    if (from) q = q.where("createdAt", ">=", Date.parse(from));
    if (to)   q = q.where("createdAt", "<",  Date.parse(to));

    const snap = await q.get();
    const rows = snap.docs.map(d => {
      const x: any = d.data();
      const line = (x.lineItems||[]).map((li: any)=>`${li.name}×${li.qty}`).join(" / ");
      return [
        d.id,
        new Date(x.createdAt||0).toLocaleString("ja-JP"),
        x.customer?.name || "",
        x.customer?.email || "",
        x.customer?.phone || "",
        x.customer?.address || "",
        x.currency || "jpy",
        x.amountTotal || 0,
        line,
      ];
    });

    const header = ["注文ID","日時","顧客名","メール","電話","住所","通貨","合計","明細"];
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
    ).join("\r\n");

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders_${siteKey}.csv"`,
      },
    });
  } catch (e) {
    console.error("[orders.export] error:", e);
    return new NextResponse("server error", { status: 500 });
  }
}
