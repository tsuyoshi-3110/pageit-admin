// app/(your-page)/PostList.tsx
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import clsx from "clsx";

// 新規投稿フォーム（プロジェクトの実際のパスに合わせてください）
import PostForm from "@/components/PastForm";

// Firebase
import {
  collection,
  query,
  orderBy,
  where,
  limit as qLimit,
  startAfter,
  getDocs,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  QueryDocumentSnapshot,
  DocumentData,
  Timestamp,
  deleteField,
  addDoc,
  getDoc,
} from "firebase/firestore";
import {
  getStorage,
  ref,
  deleteObject,
  uploadBytesResumable,
  getDownloadURL,
} from "firebase/storage";
import { auth, db } from "@/lib/firebase";

// サイトキー
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

// いいねボタン（API 経由版・互換 props 対応）
import LikeButton from "@/components/LikeButton";

// 1:1 メディア表示（画像/動画対応）
import ProductMedia from "@/components/ProductMedia";
import { Loader2, Paperclip, Send, X } from "lucide-react";

/* ---- メディア許容 & 制限 ---- */
const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_VIDEO = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
];
const MAX_VIDEO_SEC = 60; // 1分

const LIMIT = 30;

/* Firestore の Post 形（旧データ互換も考慮） */
type Post = {
  id: string;
  content: string;
  authorName: string;
  authorIconUrl: string;
  authorSiteKey: string;
  authorUid: string;
  likeCount?: number;
  commentCount?: number;
  createdAt?: Timestamp;
  mediaUrl?: string;
  mediaType?: "image" | "video" | null;
  imageUrl?: string;
};

type Comment = {
  id: string;
  content: string;
  authorUid: string | null;
  authorName?: string;
  authorIconUrl?: string | null;
  createdAt?: Timestamp;
  mediaUrl?: string | null;
  mediaType?: "image" | "video" | null;
};

/* ========================= Comments（メディア添付対応／トグル開閉） ========================= */
function Comments({ postId, myUid }: { postId: string; myUid: string | null }) {
  const [items, setItems] = useState<Comment[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // 入力欄の開閉
  const [composerOpen, setComposerOpen] = useState(false);

  // コメント用：任意で画像 or 動画（1つ）
  const [file, setFile] = useState<File | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadTask, setUploadTask] = useState<ReturnType<
    typeof uploadBytesResumable
  > | null>(null);

  // サイト設定（表示＆保存に利用）
  const [siteName, setSiteName] = useState<string>("");
  const [logoUrl, setLogoUrl] = useState<string>("");

  // 現在ログイン中の UID（削除ボタン表示制御に使用）
  const [currentUid, setCurrentUid] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      setCurrentUid(u?.uid ?? null);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // サイト名とロゴを取得（失敗してもフォールバックあり）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [siteDoc, editableDoc] = await Promise.all([
          getDoc(doc(db, "siteSettings", SITE_KEY)),
          getDoc(doc(db, "siteSettingsEditable", SITE_KEY)),
        ]);
        if (!mounted) return;
        setSiteName(String(siteDoc.data()?.siteName ?? ""));
        setLogoUrl(String(editableDoc.data()?.headerLogoUrl ?? ""));
      } catch (e) {
        console.warn("サイト設定の取得に失敗:", e);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // コメント一覧を購読
  useEffect(() => {
    const qy = query(
      collection(db, "posts", postId, "comments"),
      orderBy("createdAt", "asc"),
      qLimit(200)
    );
    const unsub = onSnapshot(qy, (snap) => {
      setItems(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Comment, "id">),
        }))
      );
    });
    return () => unsub();
  }, [postId]);

  // ファイル選択（プレビューは出さず、動画は60秒以内チェックだけ行う）
  const handlePick = (f: File | null) => {
    if (!f) {
      setFile(null);
      setIsVideo(false);
      return;
    }

    const type = f.type;
    const img = ALLOWED_IMG.includes(type);
    const vid = ALLOWED_VIDEO.includes(type);
    if (!img && !vid) {
      alert(
        "対応していないファイル形式です（画像: jpg/png/webp/gif、動画: mp4/webm/ogg/quicktime）"
      );
      return;
    }

    if (vid) {
      // 60秒以内チェック（blob URL は検証後すぐ破棄）
      const blobUrl = URL.createObjectURL(f);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = blobUrl;
      v.onloadedmetadata = () => {
        const sec = v.duration ?? 0;
        URL.revokeObjectURL(blobUrl);
        if (sec > MAX_VIDEO_SEC) {
          alert("動画は1分（60秒）以内にしてください。");
          return;
        }
        setFile(f);
        setIsVideo(true);
      };
      v.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        alert("動画の読み込みに失敗しました。別ファイルをお試しください。");
      };
      return;
    }

    // 画像
    setFile(f);
    setIsVideo(false);
  };

  // 送信（テキストのみでもOK / メディアは任意）
  const send = async () => {
    const body = text.trim();
    if (!body) {
      alert("コメント本文を入力してください。");
      return;
    }
    if (!myUid) {
      alert("ログインが必要です。");
      return;
    }

    setSending(true);
    setUploadPct(null);

    try {
      // 1) メディアがあれば先に Storage へアップロード
      let mediaUrl: string | null = null;
      let mediaType: "image" | "video" | null = null;

      if (file) {
        const storage = getStorage();
        const safeName = `${Date.now()}_${
          file.name ?? (isVideo ? "video.mp4" : "image.jpg")
        }`;
        const storageRef = ref(storage, `comments/${postId}/${safeName}`);
        const task = uploadBytesResumable(storageRef, file);
        setUploadTask(task);
        setUploadPct(0);

        mediaUrl = await new Promise<string>((resolve, reject) => {
          task.on(
            "state_changed",
            (s) => {
              const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
              setUploadPct(pct);
            },
            reject,
            async () => {
              const url = await getDownloadURL(task.snapshot.ref);
              resolve(url);
            }
          );
        });
        mediaType = isVideo ? "video" : "image";
      }

      // 2) Firestore にコメント作成
      await addDoc(collection(db, "posts", postId, "comments"), {
        content: body,
        authorUid: myUid,
        authorName: siteName || auth.currentUser?.displayName || "Anonymous",
        authorIconUrl: logoUrl || null,
        createdAt: serverTimestamp(),
        ...(mediaUrl
          ? { mediaUrl, mediaType }
          : { mediaUrl: null, mediaType: null }),
      });

      // 入力欄リセット & 閉じる
      setText("");
      setFile(null);
      setIsVideo(false);
      setUploadPct(null);
      setUploadTask(null);
      setComposerOpen(false);
    } catch (e) {
      console.error(e);
      alert("コメントの送信に失敗しました");
      setUploadPct(null);
      setUploadTask(null);
    } finally {
      setSending(false);
    }
  };

  // 削除（本人のみ）
  const remove = async (c: Comment) => {
    if (!currentUid || currentUid !== c.authorUid) return; // ガード
    if (!confirm("このコメントを削除しますか？")) return;
    try {
      await deleteDoc(doc(db, "posts", postId, "comments", c.id));
    } catch (e) {
      console.error(e);
      alert("削除に失敗しました");
    }
  };

  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      {/* 一覧 */}
      <ul className="space-y-3">
        {items.length === 0 ? (
          <li className="text-xs text-gray-400">まだコメントはありません</li>
        ) : (
          items.map((c) => (
            <li key={c.id} className="rounded bg-gray-50 p-2">
              <div className="flex items-start gap-3">
                {/* アイコン */}
                <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full border">
                  <Image
                    src={c.authorIconUrl || logoUrl || "/noImage.png"}
                    alt={c.authorName || siteName || "user"}
                    fill
                    sizes="32px"
                    className="object-cover"
                    unoptimized
                  />
                </div>

                {/* 本文＋（添付は一覧では従来どおり表示） */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-gray-700">
                      {c.authorName || siteName || "Anonymous"}
                    </p>
                    {authReady && currentUid === c.authorUid && (
                      <button
                        className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300"
                        onClick={() => remove(c)}
                      >
                        削除
                      </button>
                    )}
                  </div>

                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">
                    {c.content}
                  </p>

                  {/* 添付（既存コメントにある場合のみ表示） */}
                  {c.mediaUrl && c.mediaType && (
                    <div className="mt-2 overflow-hidden rounded border border-gray-200">
                      <ProductMedia
                        src={c.mediaUrl}
                        type={c.mediaType}
                        className="bg-black/5"
                        alt="comment-attachment"
                      />
                    </div>
                  )}

                  {c.createdAt?.toDate && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      {c.createdAt.toDate().toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))
        )}
      </ul>

      {/* 入力（ボタンで開閉：テキスト必須／メディア任意） */}
      <div className="mt-4">
        {/* トグルボタン */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() =>
              myUid
                ? setComposerOpen((v) => !v)
                : alert("ログインするとコメントできます")
            }
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            disabled={!myUid}
          >
            {composerOpen ? "入力欄を閉じる" : "コメントする"}
          </button>
        </div>

        {/* 入力フォーム（開いている時のみ） */}
        {composerOpen && (
          <div className="mt-3 rounded-xl border border-gray-200 bg-blue-100 overflow-hidden">
            {/* ヘッダー：タイトル + 文字数 */}
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <div className="text-sm font-medium text-gray-700">
                コメントを書く
              </div>
              <div className="text-xs text-gray-500">
                {text.trim().length}/2000
              </div>
            </div>

            <div className="p-3 space-y-3">
              {/* テキスト */}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  myUid ? "コメントを入力…" : "ログインするとコメントできます"
                }
                className="w-full min-h-[88px] bg-white rounded-lg border px-3 py-2 text-sm disabled:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                disabled={!myUid || sending || uploadPct !== null}
              />

              {/* 添付行：プレビューは出さず、ファイル名のみ表示 */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs text-gray-700 cursor-pointer">
                    <Paperclip className="h-4 w-4" />
                    <span>画像/動画を添付（任意）</span>
                    <input
                      type="file"
                      accept={[...ALLOWED_IMG, ...ALLOWED_VIDEO].join(",")}
                      className="hidden"
                      disabled={!myUid || sending || uploadPct !== null}
                      onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
                    />
                  </label>

                  {/* 選択中のファイル名（チップ表示） */}
                  {file && (
                    <div className="flex items-center gap-2 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                      <span className="max-w-[28ch] truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => handlePick(null)}
                        className="hover:text-gray-900"
                        disabled={sending || uploadPct !== null}
                        aria-label="添付を取り消す"
                        title="添付を取り消す"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 送信ボタン（中央寄せ） */}
              <button
                onClick={send}
                disabled={
                  sending || !text.trim() || !myUid || uploadPct !== null
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span>送信</span>
              </button>

              {/* 送信中のアップロード進捗（バーのみ） */}
              {uploadPct !== null && (
                <div className="pt-1">
                  <div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${uploadPct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-gray-600">
                    <span>アップロード中… {uploadPct}%</span>
                    {uploadTask?.snapshot.state === "running" && (
                      <button
                        type="button"
                        onClick={() => uploadTask.cancel()}
                        className="text-red-600 hover:underline"
                      >
                        キャンセル
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ログイン促し（未ログイン時のみ） */}
              {!myUid && (
                <p className="text-xs text-red-600">
                  ログインするとコメントできます
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================= メイン一覧 ========================= */
export default function PostList() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  // ページング
  const [lastCursor, setLastCursor] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // 編集モーダル
  const [editTarget, setEditTarget] = useState<Post | null>(null);
  const [editText, setEditText] = useState("");

  // 編集用メディア差し替え
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editIsVideo, setEditIsVideo] = useState(false);
  const [editPreviewUrl, setEditPreviewUrl] = useState<string | undefined>(
    undefined
  );
  const [editUploadPct, setEditUploadPct] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<ReturnType<
    typeof uploadBytesResumable
  > | null>(null);

  // ログイン監視
  useEffect(() => auth.onAuthStateChanged((u) => setUid(u?.uid ?? null)), []);

  // リアルタイム：最新 LIMIT 件（mineOnly/uid 変化で貼り替え）
  // リアルタイム：最新 LIMIT 件（mineOnly/uid 変化で貼り替え）
  useEffect(() => {
    if (mineOnly && !uid) {
      setPosts([]);
      setHasMore(false);
      setLastCursor(null);
      return;
    }

    const base = collection(db, "posts");
    const qy = mineOnly
      ? query(
          base,
          where("authorUid", "==", uid),
          orderBy("createdAt", "desc"),
          qLimit(LIMIT)
        )
      : query(base, orderBy("createdAt", "desc"), qLimit(LIMIT));

    // ★ 追加：フィルター（mineOnly/uid）が切り替わったら一旦リセット
    setPosts([]);
    setLastCursor(null);
    setHasMore(true);

    const unsub = onSnapshot(qy, (snap) => {
      const head: Post[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Post, "id">),
      }));
      const headIds = new Set(head.map((h) => h.id));

      // ここはこのままでもOK（直前で prev を空にしているため混ざらない）
      setPosts((prev) => {
        const tail = prev.filter((p) => !headIds.has(p.id));
        return [...head, ...tail];
      });

      setLastCursor(snap.docs.at(-1) ?? null);
      setHasMore(snap.size === LIMIT);
    });

    return () => unsub();
  }, [mineOnly, uid]);

  // 追加読み込み
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !lastCursor) return;

    setLoadingMore(true);
    const base = collection(db, "posts");
    const qy = mineOnly
      ? query(
          base,
          where("authorUid", "==", uid),
          orderBy("createdAt", "desc"),
          startAfter(lastCursor),
          qLimit(LIMIT)
        )
      : query(
          base,
          orderBy("createdAt", "desc"),
          startAfter(lastCursor),
          qLimit(LIMIT)
        );

    const snap = await getDocs(qy);
    const page: Post[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Post, "id">),
    }));

    setPosts((prev) => {
      const exists = new Set(prev.map((p) => p.id));
      const dedup = page.filter((p) => !exists.has(p.id));
      return [...prev, ...dedup];
    });

    setLastCursor(snap.docs.at(-1) ?? null);
    setHasMore(snap.size === LIMIT);
    setLoadingMore(false);
  }, [hasMore, loadingMore, lastCursor, mineOnly, uid]);

  // IntersectionObserver
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && loadMore(),
      { threshold: 0.5 }
    );
    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [loadMore]);

  // プレビューURLクリーンアップ（編集モーダルでのみ使用）
  useEffect(
    () => () => {
      if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl);
    },
    [editPreviewUrl]
  );

  /* ===== 編集・削除 ===== */
  const openEdit = (post: Post) => {
    setEditTarget(post);
    setEditText(post.content ?? "");
    setEditPreviewUrl(undefined);
    setEditFile(null);
    setEditIsVideo(false);
  };
  const closeEdit = () => {
    setEditTarget(null);
    setEditText("");
    setEditFile(null);
    setEditPreviewUrl(undefined);
    setEditIsVideo(false);
    setEditUploadPct(null);
    setEditTask(null);
  };

  const handlePickEditFile = (f: File | null) => {
    if (!f) {
      setEditFile(null);
      setEditPreviewUrl(undefined);
      setEditIsVideo(false);
      return;
    }
    const type = f.type;
    const isImg = ALLOWED_IMG.includes(type);
    const isVid = ALLOWED_VIDEO.includes(type);
    if (!isImg && !isVid) {
      alert(
        "対応していないファイル形式です（画像: jpg/png/webp/gif、動画: mp4/webm/ogg/quicktime）"
      );
      return;
    }
    const blobUrl = URL.createObjectURL(f);

    if (isVid) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = blobUrl;
      v.onloadedmetadata = () => {
        const sec = v.duration ?? 0;
        if (sec > MAX_VIDEO_SEC) {
          alert("動画は1分（60秒）以内にしてください。");
          URL.revokeObjectURL(blobUrl);
          return;
        }
        setEditFile(f);
        setEditIsVideo(true);
        setEditPreviewUrl(blobUrl);
      };
      v.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        alert("動画の読み込みに失敗しました。別ファイルをお試しください。");
      };
      return;
    }

    setEditFile(f);
    setEditIsVideo(false);
    setEditPreviewUrl(blobUrl);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    try {
      // 本文だけ先に更新
      await updateDoc(doc(db, "posts", editTarget.id), {
        content: editText.trim(),
        updatedAt: serverTimestamp(),
      });

      // メディア差し替え
      if (editFile) {
        setEditUploadPct(0);

        const storage = getStorage();
        const storageRef = ref(
          storage,
          `posts/${editTarget.id}/${editFile.name}`
        );
        const task = uploadBytesResumable(storageRef, editFile);
        setEditTask(task);

        const newUrl: string = await new Promise((resolve, reject) => {
          task.on(
            "state_changed",
            (s) =>
              setEditUploadPct(
                Math.round((s.bytesTransferred / s.totalBytes) * 100)
              ),
            reject,
            async () => resolve(await getDownloadURL(task.snapshot.ref))
          );
        });

        // Firestore を新URLで更新
        await updateDoc(doc(db, "posts", editTarget.id), {
          mediaUrl: newUrl,
          mediaType: editIsVideo ? "video" : "image",
          ...(editIsVideo ? { imageUrl: deleteField() } : { imageUrl: newUrl }),
          updatedAt: serverTimestamp(),
        });

        // 旧オブジェクトは後で削除（失敗は握りつぶし）
        const oldUrl = editTarget.mediaUrl || editTarget.imageUrl;
        if (oldUrl) {
          try {
            await deleteObject(ref(storage, oldUrl));
          } catch {}
        }
      }

      // ローカル即時反映
      setPosts((prev) =>
        prev.map((p) => {
          if (p.id !== editTarget.id) return p;
          const base: Post = { ...p, content: editText.trim() };
          if (!editFile) return base;
          const tempUrl: string | undefined =
            editPreviewUrl ?? p.mediaUrl ?? p.imageUrl ?? undefined;
          return {
            ...base,
            mediaType: editIsVideo ? "video" : "image",
            mediaUrl: tempUrl,
            ...(editIsVideo ? { imageUrl: undefined } : { imageUrl: tempUrl }),
          };
        })
      );

      closeEdit();
    } catch (e) {
      console.error(e);
      alert("更新に失敗しました");
      setEditUploadPct(null);
    }
  };

  const deletePost = async (post: Post) => {
    if (!confirm("この投稿を削除しますか？")) return;
    try {
      await deleteDoc(doc(db, "posts", post.id));
      const storage = getStorage();
      const targetUrl = post.mediaUrl || post.imageUrl;
      if (targetUrl) {
        try {
          await deleteObject(ref(storage, targetUrl));
        } catch {}
      }
      setPosts((prev) => prev.filter((p) => p.id !== post.id));
    } catch (e) {
      console.error(e);
      alert("削除に失敗しました");
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-8 pb-28">
      {/* フィルタ */}
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => setMineOnly((v) => !v)}
          disabled={!uid}
          className={clsx(
            "rounded-full px-4 py-2 text-sm font-semibold transition",
            mineOnly
              ? "bg-purple-600 text-white hover:bg-purple-700"
              : "bg-gray-300 text-gray-800 hover:bg-gray-400",
            !uid && "cursor-not-allowed opacity-40"
          )}
        >
          {mineOnly ? "全ての投稿を表示" : "自分の投稿だけ"}
        </button>
      </div>

      {/* 投稿カード一覧 */}
      <div className="grid grid-cols-1 gap-6">
        {posts.length === 0 ? (
          <p className="text-center text-sm text-gray-500">
            表示できる投稿がありません
          </p>
        ) : (
          <div className="divide-y divide-gray-200">
            {posts.map((p) => (
              <div key={p.id} className="py-6">
                <Card
                  post={p}
                  myUid={uid}
                  onEdit={openEdit}
                  onDelete={deletePost}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 追加ロード監視用 */}
      <div ref={sentinelRef} className="h-10" />

      {/* ローディングインジケーター */}
      {loadingMore && (
        <p className="mt-4 text-center text-sm text-gray-400">読み込み中...</p>
      )}

      {/* 新規投稿モーダル */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setShowForm(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-center text-lg font-bold">新規投稿</h2>
            <PostForm />
            <button
              onClick={() => setShowForm(false)}
              className="mx-auto mt-4 block rounded-full bg-gray-500 px-6 py-2 text-sm text-white hover:bg-gray-600"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 編集モーダル */}
      {editTarget && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onClick={closeEdit}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-center text-lg font-bold">投稿を編集</h3>

            {/* 本文 */}
            <textarea
              className="h-40 w-full rounded border p-2"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />

            {/* ファイル選択 */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded bg-gray-200 px-3 py-1 text-sm">
                画像/動画を選択して差し替え
                <input
                  type="file"
                  accept={[...ALLOWED_IMG, ...ALLOWED_VIDEO].join(",")}
                  className="hidden"
                  onChange={(e) =>
                    handlePickEditFile(e.target.files?.[0] ?? null)
                  }
                />
              </label>
              {editFile && (
                <span className="max-w-[40ch] truncate text-xs text-gray-600">
                  選択中: {editFile.name}
                </span>
              )}
              {editFile && (
                <button
                  type="button"
                  onClick={() => handlePickEditFile(null)}
                  className="rounded bg-gray-300 px-3 py-1 text-xs hover:bg-gray-400"
                >
                  取り消し
                </button>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeEdit}
                className="rounded bg-gray-300 px-4 py-2 text-sm hover:bg-gray-400"
              >
                キャンセル
              </button>
              <button
                onClick={saveEdit}
                disabled={editUploadPct !== null}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>

          {/* アップロード進捗 */}
          {editUploadPct !== null && (
            <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
              <div className="w-80 max-w-[90vw] rounded-xl bg-white p-4 shadow-xl">
                <p className="mb-2 text-center text-sm font-medium text-gray-800">
                  アップロード中… {editUploadPct}%
                </p>
                <div className="h-3 w-full rounded bg-gray-200">
                  <div
                    className="h-full rounded bg-blue-500 transition-all"
                    style={{ width: `${editUploadPct}%` }}
                  />
                </div>
                {editTask?.snapshot.state === "running" && (
                  <button
                    type="button"
                    onClick={() => editTask.cancel()}
                    className="mx-auto mt-3 block text-xs text-red-600 hover:underline"
                  >
                    キャンセル
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 新規投稿ボタン */}
      <button
        onClick={() => setShowForm(true)}
        className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full bg-green-500 px-8 py-3 text-base font-semibold text-white shadow-lg transition hover:bg-green-600"
      >
        ＋ 新しい投稿
      </button>
    </div>
  );
}

/* ========================= 単一カード ========================= */
function Card({
  post,
  myUid,
  onEdit,
  onDelete,
}: {
  post: Post;
  myUid: string | null;
  onEdit: (p: Post) => void;
  onDelete: (p: Post) => void;
}) {
  const isVideo = post.mediaType === "video" && !!post.mediaUrl;

  // 画像・動画どちらでも使える URL（なければ undefined）
  const mediaUrl: string | undefined = isVideo
    ? post.mediaUrl!
    : post.mediaUrl || post.imageUrl || undefined;

  const isMine = !!myUid && post.authorUid === myUid;

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow">
      {/* ヘッダー */}
      <header className="mb-3 flex items-center gap-3">
        <div className="relative h-10 w-10 shrink-0">
          <Image
            src={post.authorIconUrl || "/noImage.png"}
            alt={post.authorName || "user"}
            fill
            sizes="40px"
            className="rounded-full object-cover"
            unoptimized
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900">
            {post.authorName || "Anonymous"}
          </p>
          {post.createdAt?.toDate && (
            <p className="text-xs text-gray-500">
              {post.createdAt.toDate().toLocaleString()}
            </p>
          )}
        </div>

        {isMine && (
          <div className="flex gap-2">
            <button
              onClick={() => onEdit(post)}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
            >
              編集
            </button>
            <button
              onClick={() => onDelete(post)}
              className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
            >
              削除
            </button>
          </div>
        )}
      </header>

      {/* 本文 */}
      <p className="whitespace-pre-wrap text-sm text-gray-800">
        {post.content}
      </p>

      {/* メディア（1:1 表示） */}
      {mediaUrl && (
        <div className="mt-3 overflow-hidden rounded-lg border border-gray-200">
          <ProductMedia
            src={mediaUrl}
            type={isVideo ? "video" : "image"}
            className="bg-black/5"
            alt="attachment"
          />
        </div>
      )}

      {/* アクション列：いいね */}
      <div className="mt-3 flex items-center justify-between">
        <LikeButton postId={post.id} initialLikeCount={post.likeCount ?? 0} />
      </div>

      {/* コメント（テキストのみもOK・添付は任意） */}
      <Comments postId={post.id} myUid={myUid} />
    </article>
  );
}
