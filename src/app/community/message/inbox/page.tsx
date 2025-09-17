"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  Timestamp,
  doc,
  getDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";
import Image from "next/image";
import { useAtom } from "jotai";
import { partnerSiteKeyAtom } from "@/lib/atoms/siteKeyAtom";
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

/* ───────── 自店舗 ID ───────── */

const DUMMY_IMG = "/noImage.png";

/* ---------- 型 ---------- */
type MetaRow = {
  partnerSiteKey: string;
  lastMessage: string;
  updatedAt?: Timestamp;
  iconUrl?: string;
  hasUnread?: boolean;
};

export default function InboxPage() {
  const [, setPartnerSiteKey] = useAtom(partnerSiteKeyAtom);
  const [rows, setRows] = useState<MetaRow[]>([]);

  /* ────────── メタ購読 ────────── */
  useEffect(() => {
    const q = query(
      collection(db, `siteMessageMeta/${SITE_KEY}/conversations`),
      orderBy("updatedAt", "desc")
    );

    const unsub = onSnapshot(q, async (snap) => {
      const next = await Promise.all(
        snap.docs.map(async (d) => {
          const {
            partnerSiteKey = d.id,
            lastMessage,
            updatedAt,
            iconUrl,
            hasUnread = false,
          } = d.data() as MetaRow;

          /* ロゴが無ければ編集可能設定から取得 */
          let logo = iconUrl;
          if (!logo) {
            const s = await getDoc(
              doc(db, "siteSettingsEditable", partnerSiteKey)
            );
            logo = s.exists() ? (s.data().headerLogoUrl as string) : undefined;
          }

          return {
            partnerSiteKey,
            lastMessage,
            updatedAt,
            iconUrl: logo ?? DUMMY_IMG,
            hasUnread,
          } as MetaRow;
        })
      );

      setRows(next);
    });

    return () => unsub();
  }, []);

  /* ────────── UI ────────── */
  return (
    <main className="max-w-xl mx-auto mt-10">
      <h1 className="mb-6 text-center text-2xl font-bold">チャット一覧</h1>

      {rows.length === 0 ? (
        <p className="text-center text-sm text-gray-500">
          メッセージ履歴がありません。
        </p>
      ) : (
        <ul className="divide-y divide-gray-300">
          {rows.map(
            ({
              partnerSiteKey,
              lastMessage,
              updatedAt,
              iconUrl,
              hasUnread,
            }) => (
              <li key={partnerSiteKey}>
                <Link
                  href={`/community/message/${partnerSiteKey}`}
                  onClick={() => setPartnerSiteKey(partnerSiteKey)}
                  className="flex items-center gap-4 px-4 py-3 transition hover:bg-gray-100"
                >
                  {/* アイコン */}
                  <Image
                    src={iconUrl ?? ""}
                    alt={partnerSiteKey}
                    width={48}
                    height={48}
                    className="rounded-full object-cover"
                    unoptimized 
                  />

                  {/* 相手名・最終メッセージ・未読バッジ */}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate font-semibold">
                      {partnerSiteKey}
                      {hasUnread && (
                        <span className="rounded bg-red-500 px-2 py-0.5 text-xs text-white">
                          未読
                        </span>
                      )}
                    </p>
                    <p className="truncate text-sm text-gray-600">
                      {lastMessage}
                    </p>
                  </div>

                  {/* 最終更新時刻 */}
                  {updatedAt && (
                    <span className="whitespace-nowrap text-xs text-gray-400">
                      {updatedAt.toDate().toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </Link>
              </li>
            )
          )}
        </ul>
      )}
    </main>
  );
}
