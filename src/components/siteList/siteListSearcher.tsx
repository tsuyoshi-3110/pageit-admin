"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { Site, PaymentStatus } from "@/lib/type/siteListType";

type FilterMode = "all" | "paid" | "free" | "unpaid";

type Props = {
  filterMode: FilterMode;
  searchKeyword: string;
  setSearchKeyword: (kw: string) => void;
  className?: string;
  debounceMs?: number; // 重いフィルタなら 500–700 に
};

export default function SiteListSearcher({
  filterMode,
  searchKeyword,
  setSearchKeyword,
  className = "mt-3",
  debounceMs = 300,
}: Props) {
  const [draft, setDraft] = useState(searchKeyword ?? "");
  const [isComposing, setIsComposing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => setDraft(searchKeyword ?? ""), [searchKeyword]);

  const modeLabel = useMemo(() => {
    switch (filterMode) {
      case "paid":
        return "（有料のみ）";
      case "free":
        return "（無料のみ）";
      case "unpaid":
        return "（未払いのみ）";
      default:
        return "";
    }
  }, [filterMode]);

  useEffect(() => {
    if (isComposing) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setSearchKeyword(draft.trim());
      timerRef.current = null;
    }, debounceMs);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [draft, isComposing, debounceMs, setSearchKeyword]);

  return (
    <div className={className}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          type="search"
          role="searchbox"
          inputMode="search"
          enterKeyHint="search"
          placeholder={`${modeLabel}名前・電話・メールで検索`}
          className="pl-9"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
        />
      </div>
    </div>
  );
}






export const UNPAID_STATUSES: PaymentStatus[] = [
  "none",
  "canceled",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "unpaid",
];

// 全半角/ダッシュや連続空白をならす
export function normalizeQuery(str?: string) {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐-‒–—―ー−\-‐\s]+/g, " ")
    .trim();
}

// サイトのモードを判定（親でも使い回せます）
export function computeMode(s: Site): Exclude<FilterMode, "all"> {
  if (s.paymentStatus === "active" || s.paymentStatus === "pending_cancel")
    return "paid";
  if (s.isFreePlan) return "free";
  return "unpaid";
}

// 一括フィルタ（モード→キーワード）
// ※ 並び替えは親側で実施する想定（必要ならここに追加してもOK）
export function filterSites(
  list: Site[],
  filterMode: FilterMode,
  keyword: string
): Site[] {
  const byMode =
    filterMode === "all"
      ? list
      : list.filter((s) => {
          if (filterMode === "free") return !!s.isFreePlan;
          if (filterMode === "paid")
            return (
              s.paymentStatus === "active" ||
              s.paymentStatus === "pending_cancel"
            );
          // unpaid
          return (
            !s.isFreePlan &&
            !!s.paymentStatus &&
            UNPAID_STATUSES.includes(s.paymentStatus)
          );
        });

  const kw = normalizeQuery(keyword);
  if (!kw) return byMode;

  const tokens = kw.split(" ").filter(Boolean);
  return byMode.filter((s) => {
    const hay = normalizeQuery(
      [s.siteName, s.ownerName, s.ownerPhone, s.ownerEmail]
        .filter(Boolean)
        .join(" ")
    );
    return tokens.every((t) => hay.includes(t));
  });
}

