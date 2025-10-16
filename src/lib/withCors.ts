// src/lib/withCors.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * Pageit構成専用CORSユーティリティ
 * - すべてのオーナーサイト（*.pageit.shop, 独自ドメイン）に対応
 * - ローカル開発も許可
 */
export function withCors(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin") ?? "";

  const allowedPatterns = [
    /^https:\/\/([a-z0-9-]+\.)*pageit\.shop$/,
    /^https:\/\/([a-z0-9-]+\.)*pageit\.jp$/,
    /^http:\/\/localhost:3000$/,
  ];

  const isAllowed = allowedPatterns.some((re) => re.test(origin));

  if (isAllowed) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }

  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Max-Age", "86400");

  return res;
}

export function handlePreflight(req: NextRequest) {
  if (req.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    return withCors(req, res);
  }
  return null;
}
