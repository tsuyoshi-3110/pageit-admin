"use client";

import { useEffect, useRef, useState, KeyboardEvent } from "react";
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
  setDoc,
  doc,
  getDoc,
  limit,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAtomValue } from "jotai";
import { partnerSiteKeyAtom } from "@/lib/atoms/siteKeyAtom";
import dayjs from "dayjs";
import Image from "next/image";
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

/* ===== 定数 ===== */

const DUMMY_IMG = "/noImage.png"; // ロゴが無いとき
const INPUT_H_REM = 3.5; // 入力欄高さ (rem)

/* ===== 型 ===== */
interface Message {
  id: string;
  senderSiteKey: string;
  text: string;
  createdAt?: any;
  read: boolean;
}

export default function MessagePage() {
  /* ----- 相手 siteKey (Jotai) ----- */
  const partnerSiteKey = useAtomValue(partnerSiteKeyAtom);

  /* ----- state ----- */
  const [uid, setUid] = useState<string | null>(null);
  const [messages, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [logos, setLogos] = useState<{ my: string; partner: string }>({
    my: DUMMY_IMG,
    partner: DUMMY_IMG,
  });
  const [kbHeight, setKb] = useState(0);

  /* ----- refs ----- */
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialHRef = useRef<number | null>(null);

  /* 1. 認証監視 */
  useEffect(() => auth.onAuthStateChanged((u) => setUid(u?.uid ?? null)), []);

  /* 2. ロゴ取得 */
  useEffect(() => {
    if (!partnerSiteKey) return;
    const fetchLogo = async (key: string) => {
      const s = await getDoc(doc(db, "siteSettingsEditable", key));
      return s.exists() ? (s.data().headerLogoUrl as string) : undefined;
    };
    (async () => {
      const [myLogo, partnerLogo] = await Promise.all([
        fetchLogo(SITE_KEY),
        fetchLogo(partnerSiteKey),
      ]);
      setLogos({ my: myLogo ?? DUMMY_IMG, partner: partnerLogo ?? DUMMY_IMG });
    })();
  }, [partnerSiteKey]);

  /* 3. メッセージ購読 + 既読処理 */
  useEffect(() => {
    if (!partnerSiteKey) return;
    const convId = [SITE_KEY, partnerSiteKey].sort().join("__");
    const q = query(
      collection(db, "siteMessages", convId, "messages"),
      orderBy("createdAt", "asc"),
      limit(50)
    );

    const unsub = onSnapshot(q, async (snap) => {
      /* state 更新 */
      setMsgs(
        snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<Message, "id">) } as Message)
        )
      );

      /* 未読 → 既読 */
      const batch = writeBatch(db);
      let dirty = false;
      snap.docs.forEach((d) => {
        const m = d.data() as Message;
        if (!m.read && m.senderSiteKey !== SITE_KEY) {
          batch.update(d.ref, { read: true });
          dirty = true;
        }
      });

      if (dirty) {
        await batch.commit(); // コミットは 1 回だけ
        /* 自分側メタの未読フラグを解除 */
        await setDoc(
          doc(db, "siteMessageMeta", SITE_KEY, "conversations", partnerSiteKey),
          { hasUnread: false },
          { merge: true }
        );
      }

      /* リスト最下部へスクロール */
      requestAnimationFrame(() => {
        if (bottomRef.current && listRef.current) {
          listRef.current.scrollTo({
            top: bottomRef.current.offsetTop - 48,
            behavior: "smooth",
          });
        }
      });
    });

    return () => unsub();
  }, [partnerSiteKey]);

  /* 4. iOS キーボード差分 */
  useEffect(() => {
    const onResize = () => {
      if (initialHRef.current === null)
        initialHRef.current = window.innerHeight;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      setKb(Math.max(0, (initialHRef.current ?? vh) - vh - 24));
    };
    window.visualViewport?.addEventListener("resize", onResize);
    return () => window.visualViewport?.removeEventListener("resize", onResize);
  }, []);

  /* 4‑B. キーボードが閉じた瞬間に最下部へスクロールする追⾼フック */
  useEffect(() => {
    if (kbHeight === 0) {
      // キーボードが完全に閉じた次のフレームで実行
      requestAnimationFrame(() => {
        if (bottomRef.current && listRef.current) {
          listRef.current.scrollTo({
            top: bottomRef.current.offsetTop - 48, // 48 は下マージン調整
            behavior: "smooth",
          });
        }
      });
    }
  }, [kbHeight]);

  /* 5. 送信処理 */
  const sendMessage = async () => {
    if (!text.trim() || !uid || !partnerSiteKey) return;

    const convId = [SITE_KEY, partnerSiteKey].sort().join("__");

    /* 1) メッセージ追加 */
    await addDoc(collection(db, "siteMessages", convId, "messages"), {
      senderUid: uid,
      senderSiteKey: SITE_KEY,
      text: text.trim(),
      createdAt: serverTimestamp(),
      read: false,
    });

    /* 2) メタ更新（未読フラグ） */
    const upsert = (owner: string, partner: string, unread: boolean) =>
      setDoc(
        doc(db, "siteMessageMeta", owner, "conversations", partner),
        {
          partnerSiteKey: partner,
          lastMessage: text.trim(),
          updatedAt: serverTimestamp(),
          hasUnread: unread,
        },
        { merge: true }
      );

    await Promise.all([
      upsert(SITE_KEY, partnerSiteKey, false), // 自分側→既読
      upsert(partnerSiteKey, SITE_KEY, true), // 相手側→未読
    ]);

    /* 3) 入力欄クリア */
    setText("");
    textareaRef.current?.focus();
    textareaRef.current?.style.setProperty("height", "auto");
  };

  /* partner 未選択ガード */
  if (!partnerSiteKey) {
    return (
      <main className="pt-20 text-center text-gray-600">
        相手が選択されていません。
        <br />
        チャット一覧に戻ってください。
      </main>
    );
  }

  /* 動的パディング (iOS KB) */
  const bottomPad = kbHeight + INPUT_H_REM;

  const HEADER_H_REM = 4;

  return (
    <main
      /* ❶ 画面高からヘッダー分を差し引く */
      style={{ height: `calc(100dvh - ${HEADER_H_REM}rem)` }}
      className="mx-auto w-full md:max-w-xl flex flex-col"
    >
      {/* タイトル */}
      <h1 className="mb-2 text-center text-xl font-bold text-white">
        {partnerSiteKey} とのメッセージ
      </h1>

      {/* メッセージリスト */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-2 py-4 space-y-4 bg-gray-100/30 rounded-lg"
        style={{ paddingBottom: bottomPad }}
      >
        {messages.map((m, i) => {
          const isMe = m.senderSiteKey === SITE_KEY;
          const isLast = isMe && i === messages.length - 1;
          const logo = isMe ? logos.my : logos.partner;

          return (
            <div
              key={m.id}
              className={`flex items-end ${isMe ? "justify-end" : ""}`}
            >
              {/* 相手アイコン */}
              {!isMe && (
                <Image
                  src={logo}
                  alt="logo"
                  width={32}
                  height={32}
                  className="mr-2 h-8 w-8 shrink-0 rounded-full"
                  unoptimized
                />
              )}

              {/* 吹き出し */}
              <div
                className={`max-w-[75%] rounded-xl px-4 py-2 shadow text-sm ${
                  isMe
                    ? "bg-blue-500 text-white rounded-br-none"
                    : "bg-gray-300 text-black rounded-bl-none"
                }`}
              >
                <p className="break-words whitespace-pre-wrap">{m.text}</p>
                <p className="mt-1 text-right text-[10px] opacity-70">
                  {m.createdAt?.toDate
                    ? dayjs(m.createdAt.toDate()).format("HH:mm")
                    : ""}
                  {isLast && (
                    <span className="ml-1">{m.read ? "既読" : "送信"}</span>
                  )}
                </p>
              </div>

              {/* 自分アイコン */}
              {isMe && (
                <Image
                  src={logo}
                  alt="logo"
                  width={32}
                  height={32}
                  className="ml-2 h-8 w-8 shrink-0 rounded-full"
                  unoptimized
                />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 入力フォーム */}
      <form
        onSubmit={(e) => {
          e.preventDefault(); // ← ページ遷移を抑制
          sendMessage(); // ← 送信処理
        }}
        className="border-t bg-white flex items-end gap-2 px-2 pt-2"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom,0) + 0.5rem)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder="メッセージを入力"
          onChange={(e) => {
            setText(e.target.value);
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto";
              textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
            }
          }}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          className="flex-1 resize-none overflow-hidden rounded-2xl border px-3 py-2 leading-6
               max-h-40 text-base focus:outline-none"
        />

        {/* 送信ボタンは submit のままで OK */}
        <button
          type="submit"
          disabled={!text.trim()}
          className="shrink-0 self-end rounded-full bg-blue-600 px-4 py-2 text-sm text-white
               disabled:opacity-50"
        >
          送信
        </button>
      </form>
    </main>
  );
}
