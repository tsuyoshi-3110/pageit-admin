// src/app/api/posts/[postId]/comments/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getUserFromRequest } from "@/app/api/_utils/auth";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ postId: string }> }
) {
  const { postId } = await ctx.params;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") || 30), 100);

  const snap = await adminDb
    .collection("posts")
    .doc(postId)
    .collection("comments")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const comments = snap.docs.map((d) => {
    const data = d.data() as any;
    return {
      id: d.id,
      text: String(data.text || ""),
      authorUid: String(data.authorUid || ""),
      authorName: String(data.authorName || "ユーザー"),
      authorIconUrl: String(data.authorIconUrl || ""),
      createdAt: data.createdAt?.toMillis?.() ?? null,
    };
  });

  return NextResponse.json({ ok: true, comments });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ postId: string }> }
) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { postId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const text = String(body?.text ?? "").trim();

  if (!text) {
    return NextResponse.json({ ok: false, error: "EMPTY_TEXT" }, { status: 400 });
  }
  if (text.length > 1000) {
    return NextResponse.json({ ok: false, error: "TOO_LONG" }, { status: 400 });
  }

  const postRef = adminDb.collection("posts").doc(postId);
  const commentsRef = postRef.collection("comments");
  const newRef = commentsRef.doc();

  const payload = {
    text,
    authorUid: user.uid,
    authorName: user.name ?? "ユーザー",
    authorIconUrl: user.picture ?? "",
    createdAt: FieldValue.serverTimestamp(),
  };

  await adminDb.runTransaction(async (tx) => {
    tx.set(newRef, payload);
    tx.set(
      postRef,
      { commentCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });

  const inserted = await newRef.get();
  const data = inserted.data() as any;

  return NextResponse.json({
    ok: true,
    comment: {
      id: newRef.id,
      text,
      authorUid: payload.authorUid,
      authorName: payload.authorName,
      authorIconUrl: payload.authorIconUrl,
      createdAt: data.createdAt?.toMillis?.() ?? Date.now(),
    },
  });
}
