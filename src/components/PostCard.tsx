"use client";
import Image from "next/image";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import LikeButton from "./LikeButton";
import ReplyForm from "./ReplyForm";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { partnerSiteKeyAtom } from "@/lib/atoms/siteKeyAtom";

export type Post = {
  id: string;
  authorUid: string;
  authorName: string;
  authorIconUrl: string;
  authorSiteKey: string;
  content: string;
  imageUrl?: string;
  createdAt?: any;
  likeCount: number;
};

type Reply = {
  id: string;
  authorUid: string;
  authorName: string;
  authorIconUrl?: string;
  content: string;
  createdAt?: any;
};

export default function PostCard({ post }: { post: Post }) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replying, setReplying] = useState(false);
  const [advice, setAdvice] = useState("");
  const [loadingAdvice, setLoadingAdvice] = useState(false);
  const [myUid, setMyUid] = useState<string | null>(null);
  const router = useRouter();
  const setPartnerSiteKey = useSetAtom(partnerSiteKeyAtom);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => setMyUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  const isMine = myUid === post.authorUid;

  useEffect(() => {
    if (!post?.id) return;
    const q = query(
      collection(db, "posts", post.id, "replies"),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(q, (snap) =>
      setReplies(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Reply, "id">) }))
      )
    );
    return () => unsub();
  }, [post?.id]);

  const handleAdvice = async () => {
    setLoadingAdvice(true);
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: post.content, replies }),
      });
      const data = await res.json();
      setAdvice(data.result || "助言が取得できませんでした。");
    } catch {
      setAdvice("エラーが発生しました。");
    } finally {
      setLoadingAdvice(false);
    }
  };

  return (
    <div className="mb-4 border-2 border-gray-200 dark:border-neutral-700 rounded-lg p-4 shadow-lg bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100">
      <div className="flex w-full justify-center">
        <div
          className={`flex items-start ${
            isMine ? "flex-row-reverse" : ""
          } w-full`}
        >
          <Image
            src={post.authorIconUrl || "/noImage.png"}
            alt="icon"
            width={40}
            height={40}
            className="h-10 w-10 rounded-full mr-2"
            unoptimized
          />
          <div
            className={`w-full rounded-xl px-4 py-2 shadow
              ${
                isMine
                  ? "bg-blue-500 text-white"
                  : "bg-green-500 text-white dark:bg-green-600"
              }`}
          >
            <p className="font-semibold mb-1">{post.authorName}</p>
            <p className="whitespace-pre-wrap break-words">{post.content}</p>
            {post.imageUrl && (
              <div className="mt-2">
                <Image
                  src={post.imageUrl}
                  alt="post-image"
                  width={600}
                  height={400}
                  className="rounded-lg object-contain max-h-96 w-full"
                  unoptimized
                />
              </div>
            )}
            <div className="mt-1 text-[10px] opacity-70 flex items-center gap-2 justify-end">
              <span>{dayjs(post.createdAt?.toDate()).format("MM/DD HH:mm")}</span>
              <LikeButton postId={post.id} initialLikeCount={post.likeCount ?? 0} />
            </div>
          </div>
        </div>
      </div>

      {replies.length > 0 && (
        <div className="mt-2 space-y-2 text-sm">
          {replies.map((r) => {
            const myReply = r.authorUid === myUid;
            return (
              <div
                key={r.id}
                className={`flex w-full ${
                  myReply ? "justify-end" : "justify-start"
                }`}
              >
                {!myReply && (
                  <Image
                    src={r.authorIconUrl || "/noImage.png"}
                    alt="icon"
                    width={28}
                    height={28}
                    className="h-7 w-7 rounded-full mr-2"
                    unoptimized
                  />
                )}
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 ${
                    myReply
                      ? "bg-blue-500 text-white rounded-br-none dark:bg-blue-600"
                      : "bg-gray-100 text-black dark:bg-neutral-800 dark:text-gray-100 rounded-bl-none"
                  }`}
                >
                  <p className="font-semibold">{r.authorName}</p>
                  <p className="whitespace-pre-wrap">{r.content}</p>
                  <p
                    className={`text-[10px] opacity-70 mt-1 ${
                      myReply ? "text-right" : ""
                    }`}
                  >
                    {dayjs(r.createdAt?.toDate()).format("MM/DD HH:mm")}
                  </p>
                </div>
                {myReply && (
                  <Image
                    src={r.authorIconUrl || "/noImage.png"}
                    alt="icon"
                    width={28}
                    height={28}
                    className="h-7 w-7 rounded-full ml-2"
                    unoptimized
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {replying && (
        <div className="ml-12 mt-1">
          <ReplyForm postId={post.id} onDone={() => setReplying(false)} />
        </div>
      )}

      <button
        onClick={() => setReplying(!replying)}
        className="mt-4 mx-auto rounded-full bg-blue-500 px-6 py-3 text-base font-semibold text-white shadow-lg hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500 transition mr-5"
      >
        {replying ? "投稿を閉じる" : "↩ 投稿"}
      </button>

      {!isMine && (
        <button
          onClick={() => {
            router.push(`/community/message/${post.authorSiteKey}`);
            setPartnerSiteKey(post.authorSiteKey);
          }}
          className="mt-4 mx-auto rounded-full bg-blue-500 px-6 py-3 text-base font-semibold text-white shadow-lg hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500 transition"
        >
          ✉ DMする
        </button>
      )}

      {isMine && (
        <>
          <button
            onClick={async () => {
              const confirmDelete = confirm("この投稿を削除しますか？");
              if (!confirmDelete) return;
              try {
                await deleteDoc(doc(db, "posts", post.id));
              } catch (e) {
                alert("削除に失敗しました");
                console.error(e);
              }
            }}
            className="ml-auto mt-4 block text-sm text-red-600 underline hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
          >
            この投稿を削除
          </button>

          <button
            onClick={handleAdvice}
            disabled={loadingAdvice}
            className="mt-3 w-full rounded-full bg-amber-500 px-4 py-2 text-white font-semibold hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500 transition disabled:opacity-50"
          >
            {loadingAdvice ? "助言を取得中..." : "AIに助言を求める"}
          </button>
          {advice && (
            <div className="mt-2 bg-amber-100 text-amber-800 dark:bg-amber-200 dark:text-amber-900 p-4 rounded-lg whitespace-pre-wrap text-sm">
              {advice}
            </div>
          )}
        </>
      )}
    </div>
  );
}
