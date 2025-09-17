"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "@/lib/firebase";
import { Heart } from "lucide-react";

type LikeButtonProps = {
  postId: string;
  initialLikeCount?: number;
  /** 互換用（古い呼び出しで使っていた場合） */
  count?: number;
};

export default function LikeButton({
  postId,
  initialLikeCount,
  count,
}: LikeButtonProps) {
  // props からの初期値はメモ化して依存解決
  const start = useMemo(
    () => count ?? initialLikeCount ?? 0,
    [count, initialLikeCount]
  );

  const [likeCount, setLikeCount] = useState(start);
  const [liked, setLiked] = useState(false);
  const [loading, setLoading] = useState(false);

  // ユーザーが一度でもタップしたら true（以後は初期同期や props 変化で上書きしない）
  const interactedRef = useRef(false);
  // 最新の通信だけを採用するための ID
  const latestReqRef = useRef(0);
  // postId 変化検出
  const prevPostIdRef = useRef<string | null>(null);

  // postId 変化、または start 変化時の初期化
  useEffect(() => {
    const isNewPost = prevPostIdRef.current !== postId;
    if (isNewPost) {
      // 別の投稿を見始めたら操作状態をリセット
      interactedRef.current = false;
    }
    // まだユーザー操作が無いときだけ props ベースでセット
    if (!interactedRef.current) {
      setLikeCount(start);
      setLiked(false);
    }
    prevPostIdRef.current = postId;
  }, [postId, start]);

  // サーバー状態の初期同期（ユーザー操作後は反映しない）
  useEffect(() => {
    let active = true;
    const reqId = ++latestReqRef.current;

    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken().catch(() => null);
        const res = await fetch(`/api/posts/${postId}/like`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();

        if (!active || interactedRef.current || reqId !== latestReqRef.current)
          return;

        if (typeof data.likeCount === "number") setLikeCount(data.likeCount);
        if (typeof data.liked === "boolean") setLiked(data.liked);
      } catch {
        /* 失敗時は何もしない（props のまま） */
      }
    })();

    return () => {
      active = false;
    };
  }, [postId]);

  const toggle = async () => {
    const user = auth.currentUser;
    if (!user) {
      alert("ログインが必要です。");
      return;
    }
    if (loading) return;

    interactedRef.current = true;               // 以後、初期同期は上書きしない
    const opId = ++latestReqRef.current;        // この操作を最新として記録
    setLoading(true);

    const nextLiked = !liked;

    // 楽観更新
    setLiked(nextLiked);
    setLikeCount((c) => c + (nextLiked ? 1 : -1));

    try {
      const token = await user.getIdToken();
      const method = nextLiked ? "POST" : "DELETE";
      const res = await fetch(`/api/posts/${postId}/like`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || "failed");

      // 最新操作のレスだけ反映
      if (opId === latestReqRef.current) {
        if (typeof data.likeCount === "number") setLikeCount(data.likeCount);
        if (typeof data.liked === "boolean") setLiked(data.liked);
      }
    } catch (e) {
      // 最新操作のときのみロールバック
      if (opId === latestReqRef.current) {
        setLiked(!nextLiked);
        setLikeCount((c) => c + (nextLiked ? -1 : 1));
      }
      console.error("いいね処理に失敗しました", e);
      alert("いいねできませんでした。もう一度お試しください。");
    } finally {
      if (opId === latestReqRef.current) setLoading(false);
    }
  };

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1"
      disabled={loading}
      aria-pressed={liked}
      title={liked ? "いいねを取り消す" : "いいね"}
    >
      <Heart
        className={`h-5 w-5 transition-colors ${
          liked ? "text-pink-600 fill-pink-600" : "text-gray-400"
        }`}
        fill={liked ? "currentColor" : "none"}
      />
      <span className="text-sm">{likeCount}</span>
    </button>
  );
}
