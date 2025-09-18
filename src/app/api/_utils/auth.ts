// src/app/api/_utils/auth.ts
import { NextRequest } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

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
