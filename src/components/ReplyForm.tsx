"use client";
import { useState, useEffect } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

export default function ReplyForm({
  postId,
  onDone,
}: {
  postId: string;
  onDone?: () => void;
}) {
  const [text, setText] = useState("");

  /* ----- サイト名 & アイコン URL を取得 ----- */
  const [siteName, setSiteName] = useState("Anonymous");
  const [logoUrl, setLogoUrl] = useState("/noImage.png");

  useEffect(() => {
    const fetchMeta = async () => {
      const sSnap = await getDoc(doc(db, "siteSettings", SITE_KEY));
      if (sSnap.exists()) {
        setSiteName((sSnap.data() as any).siteName ?? "Anonymous");
      }

      const eSnap = await getDoc(doc(db, "siteSettingsEditable", SITE_KEY));
      if (eSnap.exists()) {
        setLogoUrl((eSnap.data() as any).headerLogoUrl ?? "/noImage.png");
      }
    };
    fetchMeta();
  }, []);

  /* ----- 返信送信 ----- */
  const uid = auth.currentUser?.uid;

  const handleSubmit = async () => {
    if (!text.trim() || !uid) return;

    await addDoc(collection(db, "posts", postId, "replies"), {
      content: text.trim(),
      authorUid: uid,
      authorName: siteName,
      authorIconUrl: logoUrl,
      createdAt: serverTimestamp(),
    });

    setText("");
    onDone?.();
  };

  /* ----- JSX ----- */
  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="返信を入力"
        className="w-full rounded p-2 border
                   bg-gray-100 text-gray-900 placeholder-gray-500
                   dark:bg-neutral-800 dark:text-gray-100 dark:placeholder-gray-400
                   dark:border-neutral-700"
      />
      <button
        onClick={handleSubmit}
        disabled={!text.trim()}
        className="rounded px-4 py-1 font-medium
                   bg-blue-600 text-white hover:bg-blue-700
                   disabled:opacity-40
                   dark:bg-blue-500 dark:hover:bg-blue-400"
      >
        送信する
      </button>
    </div>
  );
}
