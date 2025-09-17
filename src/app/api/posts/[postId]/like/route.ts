import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs"; // Edge不可（Admin SDKを使うため）

type Ctx = { params: Promise<{ postId: string }> };

async function getUidFromReq(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const idToken = m?.[1];
  if (!idToken) throw new Error("Unauthorized: missing ID token");
  const decoded = await adminAuth.verifyIdToken(idToken);
  return decoded.uid;
}

/** 初期状態取得（likeCount と自分が like 済みか） */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { postId } = await ctx.params;
    const uid = await getUidFromReq(req).catch(() => null);

    const postRef = adminDb.doc(`posts/${postId}`);
    const [postSnap, likeSnap] = await Promise.all([
      postRef.get(),
      uid ? postRef.collection("likes").doc(uid).get() : Promise.resolve(null as any),
    ]);

    const likeCount = (postSnap.get("likeCount") as number) ?? 0;
    const liked = !!likeSnap && likeSnap.exists;

    return NextResponse.json({ ok: true, likeCount, liked });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 401 }
    );
  }
}

/** いいね */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { postId } = await ctx.params; // ★ await が必要
    const uid = await getUidFromReq(req);

    const postRef = adminDb.doc(`posts/${postId}`);
    const likeRef = postRef.collection("likes").doc(uid);

    await adminDb.runTransaction(async (tx) => {
      const like = await tx.get(likeRef);
      if (!like.exists) {
        tx.set(likeRef, { uid, likedAt: FieldValue.serverTimestamp() });
        tx.set(
          postRef,
          { likeCount: FieldValue.increment(1) },
          { merge: true }
        );
      }
    });

    const snap = await postRef.get();
    const likeCount = (snap.get("likeCount") as number) ?? 0;

    return NextResponse.json({ ok: true, liked: true, likeCount });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 400 }
    );
  }
}

/** いいね解除 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { postId } = await ctx.params; // ★ await が必要
    const uid = await getUidFromReq(req);

    const postRef = adminDb.doc(`posts/${postId}`);
    const likeRef = postRef.collection("likes").doc(uid);

    await adminDb.runTransaction(async (tx) => {
      const like = await tx.get(likeRef);
      if (like.exists) {
        tx.delete(likeRef);
        tx.set(
          postRef,
          { likeCount: FieldValue.increment(-1) },
          { merge: true }
        );
      }
    });

    const snap = await postRef.get();
    const likeCount = (snap.get("likeCount") as number) ?? 0;

    return NextResponse.json({ ok: true, liked: false, likeCount });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 400 }
    );
  }
}
