// src/app/api/_utils/auth.ts
import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

export async function getUserFromRequest(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded; // { uid, name?, picture? ... }
  } catch {
    return null;
  }
}

/** admins/{uid} に登録された管理者本人でなければエラー応答を返します。 */
export async function requireAdmin(req: Request): Promise<Response | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  let uid: string;
  try {
    ({ uid } = await adminAuth.verifyIdToken(token));
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const snapshot = await adminDb.doc(`admins/${uid}`).get();
  return snapshot.exists
    ? null
    : Response.json({ error: "forbidden" }, { status: 403 });
}

/** Vercel Cron の呼び出しか確認します。CRON_SECRET が未設定なら拒否します。 */
export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** 定期実行または管理者本人でなければエラー応答を返します。 */
export async function requireAdminOrCron(req: Request): Promise<Response | null> {
  return isCronRequest(req) ? null : requireAdmin(req);
}
