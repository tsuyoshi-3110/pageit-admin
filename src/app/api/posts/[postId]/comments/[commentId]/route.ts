import { NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

// params は Promise のため await が必要（Next の仕様）
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ postId: string; commentId: string }> }
) {
  try {
    const { postId, commentId } = await ctx.params;

    // 認証トークン
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    // コメント取得
    const commentRef = adminDb.doc(`posts/${postId}/comments/${commentId}`);
    const commentSnap = await commentRef.get();
    if (!commentSnap.exists) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const comment = commentSnap.data() as { authorUid?: string } | undefined;

    // 投稿者本人のみ削除可能（必要なら管理者・投稿オーナー等の許可も追加可能）
    if (!comment?.authorUid || comment.authorUid !== uid) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    // 削除 & 親の commentCount をデクリメント（存在すれば）
    await commentRef.delete();
    const postRef = adminDb.doc(`posts/${postId}`);
    await postRef.set({ commentCount: FieldValue.increment(-1) }, { merge: true });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("DELETE comment failed:", e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
