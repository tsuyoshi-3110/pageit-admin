"use client";
import { useState, useEffect, ChangeEvent } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from "firebase/storage";
import Image from "next/image";
import { auth, db } from "@/lib/firebase";
import { X } from "lucide-react";
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

/* 許可MIME & 制限秒数 */
const ALLOWED_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_VIDEO = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
];
const MAX_VIDEO_SEC = 60; // 1分

export default function PostForm() {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadTask, setUploadTask] = useState<ReturnType<
    typeof uploadBytesResumable
  > | null>(null);

  const [siteName, setSiteName] = useState("Anonymous");
  const [logoUrl, setLogoUrl] = useState("/noImage.png");

  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [keywords, setKeywords] = useState(["", "", ""]);
  const [generating, setGenerating] = useState(false);
  const [isSmartRephrasing, setIsSmartRephrasing] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  useEffect(() => {
    (async () => {
      const s1 = await getDoc(doc(db, "siteSettings", SITE_KEY));
      if (s1.exists()) setSiteName((s1.data() as any).siteName ?? "Anonymous");
      const s2 = await getDoc(doc(db, "siteSettingsEditable", SITE_KEY));
      if (s2.exists())
        setLogoUrl((s2.data() as any).headerLogoUrl ?? "/noImage.png");
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const uid = auth.currentUser?.uid;

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setFile(null);
      setIsVideo(false);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      return;
    }

    const type = f.type;
    const isImg = ALLOWED_IMG.includes(type);
    const isVid = ALLOWED_VIDEO.includes(type);

    if (!isImg && !isVid) {
      alert(
        "対応していないファイル形式です（画像: jpg/png/webp/gif、動画: mp4/webm/ogg/quicktime）"
      );
      e.currentTarget.value = "";
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
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
          e.currentTarget.value = "";
          return;
        }
        setFile(f);
        setIsVideo(true);
        setPreviewUrl(blobUrl);
      };
      return;
    }

    setFile(f);
    setIsVideo(false);
    setPreviewUrl(blobUrl);
  };

  const clearPickedFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setIsVideo(false);
    setPreviewUrl(null);
  };

  const submit = async () => {
    if (!uid || (!text.trim() && !file)) return;

    setUploading(true);
    setUploadPct(null);
    setUploadTask(null);

    try {
      const postRef = await addDoc(collection(db, "posts"), {
        authorUid: uid,
        authorSiteKey: SITE_KEY,
        authorName: siteName,
        authorIconUrl: logoUrl,
        content: text.trim(),
        imageUrl: "",
        mediaUrl: "",
        mediaType: null,
        likeCount: 0,
        createdAt: serverTimestamp(),
      });

      if (file) {
        const storage = getStorage();
        const storageRef = ref(storage, `posts/${postRef.id}/${file.name}`);
        const task = uploadBytesResumable(storageRef, file);
        setUploadTask(task);
        setUploadPct(0);

        const url = await new Promise<string>((resolve, reject) => {
          task.on(
            "state_changed",
            (s) => {
              const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
              setUploadPct(pct);
            },
            (err) => reject(err),
            async () => resolve(await getDownloadURL(task.snapshot.ref))
          );
        });

        await updateDoc(postRef, {
          mediaUrl: url,
          mediaType: isVideo ? "video" : "image",
          ...(isVideo ? {} : { imageUrl: url }),
        });
      }

      setText("");
      clearPickedFile();
      setIsSubmitted(true);
    } catch (e) {
      console.error(e);
      alert("投稿に失敗しました");
    } finally {
      setUploading(false);
      setUploadPct(null);
      setUploadTask(null);
    }
  };

  const generateAIText = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/generate-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords }),
      });
      const data = await res.json();
      setText(String(data?.text ?? ""));
      setAiModalOpen(false);
    } catch {
      alert("生成に失敗しました");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mb-4 space-y-3 text-gray-900 dark:text-gray-100">
      {/* アップロード進捗モーダル */}
      {uploadPct !== null && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="w-80 max-w-[90vw] rounded-xl bg-white dark:bg-neutral-800 p-4 shadow-xl">
            <p className="mb-2 text-center text-sm font-medium text-gray-800 dark:text-gray-100">
              アップロード中… {uploadPct}%
            </p>
            <div className="h-3 w-full rounded bg-gray-200 dark:bg-neutral-700">
              <div
                className="h-full rounded bg-blue-500 transition-all"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
            {uploadTask?.snapshot.state === "running" && (
              <button
                type="button"
                onClick={() => uploadTask.cancel()}
                className="mx-auto mt-3 block text-xs text-red-600 hover:underline dark:text-red-400"
              >
                キャンセル
              </button>
            )}
          </div>
        </div>
      )}

      {isSubmitted ? (
        <div className="space-y-2 text-center font-bold text-green-700 dark:text-green-400">
          <p>✅ 投稿が完了しました！</p>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="いまどうしてる？（テキストは任意）"
            className="h-40 w-full rounded border p-2 bg-white dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100"
          />

          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded bg-gray-200 dark:bg-neutral-700 px-3 py-1 text-sm text-gray-800 dark:text-gray-200">
              画像/動画を選択（任意）
              <input
                type="file"
                accept={[...ALLOWED_IMG, ...ALLOWED_VIDEO].join(",")}
                className="hidden"
                onChange={onPickFile}
              />
            </label>

            {file && (
              <>
                <span className="max-w-[50ch] truncate text-xs text-gray-600 dark:text-gray-300">
                  選択中: {file.name}
                </span>
                <button
                  type="button"
                  onClick={clearPickedFile}
                  className="rounded bg-gray-300 dark:bg-neutral-600 px-3 py-1 text-xs hover:bg-gray-400 dark:hover:bg-neutral-500"
                >
                  選択解除
                </button>
              </>
            )}
          </div>

          {previewUrl && (
            <div className="overflow-hidden rounded border border-gray-300 dark:border-neutral-700">
              {isVideo ? (
                <video
                  src={previewUrl}
                  className="h-auto w-full"
                  controls
                  playsInline
                />
              ) : (
                <Image
                  src={previewUrl}
                  alt="preview"
                  width={800} // 適当に大きめのサイズを指定
                  height={600}
                  className="h-auto w-full object-contain"
                  unoptimized // ← blob: や Firebase の場合は必須
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setAiModalOpen(true)}
              className="rounded bg-purple-600 px-3 py-1 text-white hover:bg-purple-700"
            >
              AIが文章を生成
            </button>

            <button
              onClick={async () => {
                if (!text.trim()) return;
                setIsSmartRephrasing(true);
                try {
                  const res = await fetch("/api/smart-rephrase", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                  });
                  const data = await res.json();
                  if (data.result) setText(String(data.result));
                } finally {
                  setIsSmartRephrasing(false);
                }
              }}
              className="rounded bg-purple-600 px-3 py-1 text-white hover:bg-purple-700 disabled:opacity-40"
              disabled={!text.trim() || isSmartRephrasing}
            >
              {isSmartRephrasing ? "スマート化中..." : "スマートに整える"}
            </button>
          </div>

          <button
            onClick={submit}
            disabled={(!text.trim() && !file) || uploading}
            className="rounded bg-blue-600 hover:bg-blue-700 px-4 py-1 text-white disabled:opacity-40"
          >
            {uploading ? "アップロード中..." : "投稿"}
          </button>

          {aiModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="relative w-full max-w-md space-y-4 rounded-lg bg-white dark:bg-neutral-800 p-6 text-gray-900 dark:text-gray-100">
                <button
                  onClick={() => setAiModalOpen(false)}
                  className="absolute right-2 top-2 text-gray-600 dark:text-gray-300"
                >
                  <X />
                </button>
                <h2 className="mb-2 text-lg font-bold">キーワードを3つ入力</h2>
                {keywords.map((k, i) => (
                  <input
                    key={i}
                    type="text"
                    className="w-full rounded border px-2 py-1 bg-white dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100"
                    value={k}
                    onChange={(e) => {
                      const newK = [...keywords];
                      newK[i] = e.target.value;
                      setKeywords(newK);
                    }}
                  />
                ))}
                <button
                  disabled={keywords.some((k) => !k.trim()) || generating}
                  onClick={generateAIText}
                  className="w-full rounded bg-blue-600 hover:bg-blue-700 py-2 text-white disabled:opacity-40"
                >
                  {generating ? "生成中..." : "生成する"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
