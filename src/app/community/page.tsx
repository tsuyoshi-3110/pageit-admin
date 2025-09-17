"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Image from "next/image";
import Link from "next/link";
import { useSetAtom } from "jotai";
import { partnerSiteKeyAtom } from "@/lib/atoms/siteKeyAtom";
import { Inbox } from "lucide-react";
import clsx from "clsx";
import { useThemeGradient } from "@/lib/useThemeGradient";
import { ThemeKey, THEMES } from "@/lib/themes";
import { SITE_KEY } from "@/lib/atoms/siteKeyAtom";

/* ---------- 型 ---------- */
type Industry = { key: string; name: string };

type SiteOwner = {
  id: string; // siteKey
  siteName: string;
  ownerName: string;
  ownerAddress: string;
  iconUrl: string;
  ownerId: string;
  industry?: Industry | null;
  distanceKm?: number | null;
};

type LatLng = { lat: number; lng: number };

/* ---------- 定数 ---------- */
const DARK_KEYS: ThemeKey[] = ["brandG", "brandH", "brandI"];
const collatorJa = new Intl.Collator("ja", { sensitivity: "base" });

/* ---------- 距離ユーティリティ ---------- */
const formatDistance = (km: number) => {
  if (!Number.isFinite(km)) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `約 ${km.toFixed(1)} km`;
};

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
  return R * c;
}

/* ===== 住所→緯度経度 キャッシュ（メモリ + localStorage, TTL付き）===== */
type CacheItem = { lat: number; lng: number; ts: number };
const GEO_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7日
const LS_KEY = "geocode_cache_v1";
const memCache = new Map<string, CacheItem>();
const inflight = new Map<string, Promise<LatLng | null>>();
const now = () => Date.now();

function readLS(): Record<string, CacheItem> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, CacheItem>;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function writeLS(store: Record<string, CacheItem>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {}
}
function getFromCache(address: string): LatLng | null {
  const m = memCache.get(address);
  const t = now();
  if (m && t - m.ts < GEO_TTL_MS) return { lat: m.lat, lng: m.lng };
  const ls = readLS();
  const hit = ls[address];
  if (hit && t - hit.ts < GEO_TTL_MS) {
    memCache.set(address, hit);
    return { lat: hit.lat, lng: hit.lng };
  }
  return null;
}
function setCache(address: string, ll: LatLng) {
  const item: CacheItem = { ...ll, ts: now() };
  memCache.set(address, item);
  const ls = readLS();
  ls[address] = item;
  writeLS(ls);
}
async function geocodeCached(address: string): Promise<LatLng | null> {
  if (!address || address.includes("不明")) return null;
  const hit = getFromCache(address);
  if (hit) return hit;
  const fly = inflight.get(address);
  if (fly) return fly;

  const p = (async () => {
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn("[geocode] api error", res.status, err);
        return null;
      }
      const j = (await res.json()) as any;
      if (typeof j?.lat === "number" && typeof j?.lng === "number") {
        const ll = { lat: j.lat, lng: j.lng };
        setCache(address, ll);
        return ll;
      }
      console.warn("[geocode] invalid payload", j);
      return null;
    } catch (e) {
      console.error("[geocode] fetch error", e);
      return null;
    } finally {
      inflight.delete(address);
    }
  })();
  inflight.set(address, p);
  return p;
}

/* ====== フォールバック用：業種グルーピング＆相性判定 ====== */
function groupOf(ind?: Industry | null): string {
  const s = `${ind?.key ?? ""} ${ind?.name ?? ""}`.toLowerCase();
  const hit = (kw: string[]) => kw.some((k) => s.includes(k));
  if (hit(["cafe", "喫茶", "カフェ", "coffee"])) return "cafe";
  if (hit(["ベーカリー", "パン", "sweets", "ケーキ"])) return "bakery";
  if (hit(["美容", "サロン", "ヘア", "理容", "ネイル"])) return "beauty";
  if (hit(["整骨", "整体", "マッサージ", "鍼", "フィットネス", "ジム"]))
    return "wellness";
  if (hit(["花", "フラワー", "ブーケ", "florist"])) return "florist";
  if (hit(["写真", "フォト", "photo", "スタジオ"])) return "photo";
  if (hit(["居酒屋", "レストラン", "食堂", "restaurant"])) return "restaurant";
  if (hit(["旅館", "ホテル", "宿"])) return "hotel";
  if (hit(["配達", "タクシー", "transport"])) return "transport";
  if (hit(["学習", "塾", "教育"])) return "education";
  return "other";
}
const COMPLEMENTS: Record<string, string[]> = {
  cafe: ["bakery", "florist", "photo", "restaurant"],
  bakery: ["cafe", "restaurant"],
  beauty: ["wellness", "photo", "florist"],
  wellness: ["beauty", "cafe", "restaurant"],
  florist: ["photo", "cafe", "restaurant", "hotel"],
  photo: ["florist", "beauty", "cafe", "hotel"],
  restaurant: ["cafe", "bakery", "florist"],
  hotel: ["restaurant", "photo", "florist", "transport"],
  transport: ["hotel", "restaurant"],
  education: ["cafe", "photo"],
  other: [],
};
function scorePartner(
  myGroup: string,
  partnerGroup: string,
  distanceKm?: number | null
) {
  let industry = 0.5;
  if (myGroup === partnerGroup && myGroup !== "other") industry = 0.8;
  if (COMPLEMENTS[myGroup]?.includes(partnerGroup)) industry = 1.0;

  let dist = 0.6;
  if (Number.isFinite(distanceKm as number)) {
    const d = Math.max(0, Math.min(1, 1 - Number(distanceKm) / 15));
    dist = d;
  }
  return 0.6 * industry + 0.4 * dist;
}

// ② ユーティリティを追加（ファイル先頭の関数群のそばに置くと見通し良いです）
const normalizeJa = (s: string) =>
  (s || "")
    .toString()
    .normalize("NFKC") // 全角→半角など正規化
    .toLowerCase()
    .trim();

const toTokens = (q: string) =>
  normalizeJa(q)
    .split(/\s+/) // スペース/改行で区切り
    .filter(Boolean); // 空要素除去

/* ----------  Component ---------- */
export default function CommunityPage() {
  const [owners, setOwners] = useState<SiteOwner[]>([]);
  const [query, setQuery] = useState("");
  const [best, setBest] = useState<SiteOwner | null>(null);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [reason, setReason] = useState<string>("");
  const [myIndustryName, setMyIndustryName] = useState<string>("未設定");
  const [loadingAI, setLoadingAI] = useState(false);
  const [errorAI, setErrorAI] = useState<string>("");
  const [showBestBox, setShowBestBox] = useState(true);

  // カード個別の提案結果・状態
  const [cardProposals, setCardProposals] = useState<
    Record<string, { ideas: string[]; reason: string }>
  >({});
  const [generatingCardId, setGeneratingCardId] = useState<string | null>(null);

  // ★ 追加：各カードの開閉状態
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});

  const gradient = useThemeGradient();
  const setPartnerSiteKey = useSetAtom(partnerSiteKeyAtom);

  const isDark = useMemo(
    () => !!gradient && DARK_KEYS.some((k) => gradient === THEMES[k]),
    [gradient]
  );

  useEffect(() => {
    const fetchOwners = async () => {
      // 1) 自分の住所 & 業種
      const mySnap = await getDoc(doc(db, "siteSettings", SITE_KEY));
      const myData = mySnap.data() as any;
      const myAddress = myData?.ownerAddress as string | undefined;
      const myLL = myAddress ? await geocodeCached(myAddress) : null;

      const myInd: Industry | null =
        myData?.industry && typeof myData.industry === "object"
          ? {
              key: String(myData.industry.key ?? ""),
              name: String(myData.industry.name ?? ""),
            }
          : null;
      setMyIndustryName(myInd?.name || "未設定");

      // 2) 全店舗
      const snap = await getDocs(collection(db, "siteSettings"));
      const rows = await Promise.all(
        snap.docs.map(async (d) => {
          const data = d.data() as any;
          const siteKey = d.id;

          const industry: Industry | null =
            data?.industry && typeof data.industry === "object"
              ? {
                  key: String(data.industry.key ?? ""),
                  name: String(data.industry.name ?? ""),
                }
              : null;

          const editableSnap = await getDoc(
            doc(db, "siteSettingsEditable", siteKey)
          );
          const editableData = editableSnap.exists() ? editableSnap.data() : {};

          const row: SiteOwner = {
            id: siteKey,
            siteName: data.siteName ?? "(無名の店舗)",
            ownerName: data.ownerName ?? "(名前未設定)",
            ownerAddress: data.ownerAddress ?? "(住所不明)",
            ownerId: data.ownerId ?? "",
            iconUrl: (editableData as any)?.headerLogoUrl ?? "/noImage.png",
            industry,
          };
          return row;
        })
      );

      // 3) 自分以外に絞って並べ替え
      const sorted = rows
        .filter((r) => r.id !== SITE_KEY)
        .sort((a, b) => collatorJa.compare(a.siteName, b.siteName));

      // 4) 距離付与（キャッシュ利用）
      const withDistance: SiteOwner[] = await Promise.all(
        sorted.map(async (o) => {
          if (!myLL) return { ...o, distanceKm: null };
          const ll = await geocodeCached(o.ownerAddress || "");
          if (!ll) return { ...o, distanceKm: null };
          return { ...o, distanceKm: haversineKm(myLL, ll) };
        })
      );

      setOwners(withDistance);
    };

    fetchOwners();
  }, []);

  const filteredOwners = useMemo(() => {
    const tokens = toTokens(query);
    if (tokens.length === 0) return owners;

    return owners.filter((o) => {
      const haystack = [
        o.siteName ?? "",
        o.ownerName ?? "",
        o.industry?.name ?? "",
        o.industry?.key ?? "",
      ]
        .map((s) => normalizeJa(s)) // ← string のみが渡るのでOK
        .join(" ");

      return tokens.every((t) => haystack.includes(t));
    });
  }, [owners, query]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    []
  );

  /* ===== LLMで協業先選定（ヘッダの一括ボタン） ===== */
  const handleSmartSelect = useCallback(async () => {
    if (owners.length === 0) return;
    setLoadingAI(true);
    setErrorAI("");
    setBest(null);
    setIdeas([]);
    setReason("");

    const payload = {
      myIndustry: myIndustryName || "未設定",
      candidates: owners.map((o) => ({
        id: o.id,
        siteName: o.siteName,
        industry: o.industry?.name || "未設定",
        distanceKm: o.distanceKm ?? null,
      })),
    };

    try {
      setShowBestBox(true);
      const res = await fetch("/api/partner-recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const j = await res.json();
        const selected = owners.find((o) => o.id === j.selectedId) || null;
        setBest(selected);
        setIdeas(Array.isArray(j.ideas) ? j.ideas.slice(0, 5) : []);
        setReason(typeof j.reason === "string" ? j.reason : "");
        return;
      }

      console.warn(
        "[partner-recommend] server returned",
        res.status,
        await res.text()
      );
      throw new Error("LLM選定に失敗しました");
    } catch {
      try {
        const myGroup = groupOf({ key: "", name: myIndustryName });
        let bestRow: SiteOwner | null = null;
        let bestScore = -Infinity;
        for (const o of owners) {
          const pg = groupOf(o.industry);
          const s = scorePartner(myGroup, pg, o.distanceKm);
          if (s > bestScore) {
            bestScore = s;
            bestRow = o;
          }
        }
        setBest(bestRow);
        setReason(
          "LLMが利用できなかったため、距離×業種の簡易スコアで選定しました。"
        );
        setIdeas(
          [
            "相互Instagramストーリーズで週1回のクロス紹介",
            "双方の店舗で使えるコラボ限定クーポン（1か月間）",
            "店頭POPで相互QR掲載・来店導線を相互送客",
            ...(bestRow?.distanceKm != null && bestRow.distanceKm < 3
              ? ["徒歩圏“ハシゴ割”：同日来店で双方5%OFF"]
              : ["近隣マップ（WEB）で相互紹介"]),
          ].slice(0, 5)
        );
      } catch {
        setErrorAI("候補の選定に失敗しました。");
      }
    } finally {
      setLoadingAI(false);
    }
  }, [owners, myIndustryName]);

  /* ===== カード個別：AIが協業案 ===== */
  const proposeLocal = useCallback(
    (partner: SiteOwner) => {
      const myGroup = groupOf({ key: "", name: myIndustryName });
      const pg = groupOf(partner.industry);
      const distTxt =
        partner.distanceKm != null
          ? formatDistance(partner.distanceKm)
          : "距離不明";

      const relation =
        myGroup === pg
          ? "同ジャンルの相乗効果が期待できます"
          : COMPLEMENTS[myGroup]?.includes(pg)
          ? "互いを補完する関係です"
          : "関連度は高くありませんが距離面で取り組みやすいです";

      const ideas = [
        `相互SNS紹介（ストーリーズ/リール）で近隣ユーザーに訴求（${distTxt}）`,
        `店頭QRで相互送客：「${partner.siteName}」×「${myIndustryName}」コラボ特典`,
        `季節の共同キャンペーン（${myIndustryName}×${
          partner.industry?.name ?? "相手業種"
        }）`,
        partner.distanceKm != null && partner.distanceKm < 3
          ? "徒歩圏“ハシゴ割”（同日利用で双方5%OFF）"
          : "近隣マップ（Web）で相互紹介・回遊促進",
        "共同インスタライブ or ショート動画撮影で“体験”訴求",
      ].filter(Boolean) as string[];

      return {
        reason: `距離は${distTxt}、${relation}。`,
        ideas: ideas.slice(0, 5),
      };
    },
    [myIndustryName] // ← myIndustryNameに依存
  );

  const handleProposeForCard = useCallback(
    async (partner: SiteOwner) => {
      setGeneratingCardId(partner.id);
      try {
        const res = await fetch("/api/collab-ideas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            my: { industry: myIndustryName || "未設定" },
            partner: {
              id: partner.id,
              siteName: partner.siteName,
              industry: partner.industry?.name ?? "未設定",
              distanceKm: partner.distanceKm ?? null,
            },
          }),
        });

        if (!res.ok) throw new Error(await res.text());
        const j = await res.json();

        setCardProposals((prev) => ({
          ...prev,
          [partner.id]: {
            reason: typeof j.reason === "string" ? j.reason : "",
            ideas: Array.isArray(j.ideas) ? j.ideas.slice(0, 5) : [],
          },
        }));
        setOpenCards((prev) => ({ ...prev, [partner.id]: true }));
      } catch {
        const fb = proposeLocal(partner);
        setCardProposals((prev) => ({ ...prev, [partner.id]: fb }));
        setOpenCards((prev) => ({ ...prev, [partner.id]: true }));
      } finally {
        setGeneratingCardId(null);
      }
    },
    [myIndustryName, proposeLocal] // ← proposeLocalがuseCallback化されてるのでOK
  );

  return (
    <main className="mx-auto max-w-3xl p-4 pt-20">
      {/* ヘッダ行：検索＋AI選択ボタン */}
      <div className="mb-4 flex gap-2 items-center">
        <input
          type="text"
          placeholder="店舗名/業種で検索…" // ← 変更
          value={query}
          onChange={handleChange}
          className={clsx(
            "flex-1 bg-white/50 rounded border px-3 py-2 text-sm focus:outline-none"
          )}
        />
        <button
          onClick={handleSmartSelect}
          disabled={loadingAI || owners.length === 0}
          className={clsx(
            "shrink-0 px-4 h-10 rounded-md text-white font-medium shadow transition",
            loadingAI && "opacity-70 cursor-not-allowed",
            gradient
              ? ["bg-gradient-to-r", gradient, "hover:brightness-110"]
              : "bg-indigo-600 hover:bg-indigo-500"
          )}
        >
          {loadingAI ? "選定中…" : "AIが協業先選択"}
        </button>
      </div>

      {/* 提案結果カード（全体） */}
      {showBestBox && (best || errorAI) && (
        <div
          className={clsx("mb-6 rounded-xl border p-4 shadow", "bg-white/50")}
        >
          {errorAI ? (
            <p className="text-sm text-red-600">{errorAI}</p>
          ) : best ? (
            <>
              <div className="flex items-start gap-3">
                <div className="relative h-12 w-12 shrink-0">
                  <Image
                    src={best.iconUrl}
                    alt={best.ownerName}
                    fill
                    className="object-contain"
                    unoptimized
                    sizes="48px"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-bold truncate">{best.siteName}</p>
                  <p className="text-sm opacity-80 truncate">
                    {best.industry?.name ?? "業種未設定"}／
                    {best.distanceKm != null
                      ? formatDistance(best.distanceKm)
                      : "距離不明"}
                  </p>
                  {reason && (
                    <p className="mt-1 text-xs opacity-80">{reason}</p>
                  )}
                </div>

                {/* 右側ツールバー：メッセージ ＋ 閉じる（横並び） */}
                <div className="shrink-0 flex items-center gap-2">
                  <Link
                    href={`/community/message/${best.id}`}
                    onClick={() => setPartnerSiteKey(best.id)}
                    className={clsx(
                      "inline-flex items-center justify-center text-center px-3 h-9 rounded-md text-white text-sm font-medium transition",
                      gradient
                        ? ["bg-gradient-to-r", gradient, "hover:brightness-110"]
                        : "bg-blue-600 hover:bg-blue-700"
                    )}
                  >
                    メッセージ
                  </Link>

                  <button
                    onClick={() => setShowBestBox(false)}
                    className="px-3 h-9 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm"
                    aria-label="提案を閉じる"
                  >
                    閉じる
                  </button>
                </div>
              </div>

              {ideas.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-semibold mb-2">提案（例）</p>
                  <ul className="list-disc pl-5 space-y-1 text-sm">
                    {ideas.slice(0, 5).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* 一覧（カード単位のAI提案ボタン付き） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {filteredOwners.map((o) => {
          const proposal = cardProposals[o.id];
          const busy = generatingCardId === o.id;
          const isOpen = !!openCards[o.id];

          return (
            <div
              key={o.id}
              className={clsx(
                "relative grid grid-cols-[auto_1fr] items-start gap-4",
                "bg-gray-300 rounded-lg border p-4 shadow transition hover:shadow-md",
                "min-h-56"
              )}
            >
              {/* 左: アイコン */}
              <div className="relative h-16 w-16 shrink-0">
                <Image
                  src={o.iconUrl}
                  alt={o.ownerName}
                  fill
                  className="object-contain"
                  unoptimized
                  sizes="64px"
                />
              </div>

              {/* 中: テキスト */}
              <div className="min-w-0 flex flex-col justify-start pb-14">
                <p className="font-bold truncate text-black" title={o.siteName}>
                  {o.siteName}
                </p>
                <p className="text-sm truncate text-black" title={o.ownerName}>
                  by&nbsp;{o.ownerName}
                </p>

                {/* 業種 */}
                {o.industry?.name && (
                  <div className="mt-1">
                    <span
                      className={clsx(
                        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                        isDark
                          ? "bg-black/60 text-white"
                          : "bg-gray-800 text-white"
                      )}
                      title={o.industry.name}
                    >
                      {o.industry.name}
                    </span>
                  </div>
                )}

                {/* 距離 */}
                {o.distanceKm != null && (
                  <p className={clsx("mt-1 text-xs", "text-gray-700")}>
                    距離：{formatDistance(o.distanceKm)}
                  </p>
                )}

                {/* 提案結果（カード個別：開いているときだけ見せる） */}
                {proposal && isOpen && (
                  <div className="mt-2 relative pr-14">
                    {/* 右上に閉じるボタン */}
                    <button
                      onClick={() =>
                        setOpenCards((prev) => ({ ...prev, [o.id]: false }))
                      }
                      className={clsx(
                        "absolute top-0 right-0 inline-flex items-center rounded px-2 h-6 text-xs",
                        "bg-gray-200 hover:bg-gray-300 text-gray-700"
                      )}
                      aria-label="提案を閉じる"
                    >
                      閉じる
                    </button>

                    {proposal.reason && (
                      <p className="text-xs opacity-80 mb-1 text-black">
                        {proposal.reason}
                      </p>
                    )}
                    {proposal.ideas?.length > 0 && (
                      <ul className="list-disc pl-5 space-y-1 text-xs text-black">
                        {proposal.ideas.slice(0, 5).map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* 左下：AI提案ボタン（挙動は従来どおり） */}
              <button
                onClick={() => handleProposeForCard(o)}
                disabled={busy}
                className={clsx(
                  "absolute bottom-4 left-4 inline-flex h-9 items-center justify-center rounded px-3 text-sm font-medium",
                  "text-white shadow-md transition",
                  busy && "opacity-70 cursor-not-allowed",
                  gradient
                    ? ["bg-gradient-to-r", gradient, "hover:brightness-110"]
                    : "bg-emerald-600 hover:bg-emerald-700"
                )}
                aria-label={`${o.siteName} との協業案をAIで考える`}
              >
                {busy ? "提案中…" : "AIが協業案"}
              </button>

              {/* 右下：メッセージボタン */}
              <Link
                href={`/community/message/${o.id}`}
                onClick={() => setPartnerSiteKey(o.id)}
                className={clsx(
                  "absolute bottom-4 right-4 inline-flex h-9 items-center justify-center rounded px-3 text-sm font-medium",
                  "text-white shadow-md transition focus:outline-none focus:ring-2 focus:ring-offset-2",
                  gradient
                    ? [
                        "bg-gradient-to-r",
                        gradient,
                        "hover:brightness-110",
                        isDark ? "focus:ring-white/40" : "focus:ring-black/30",
                      ]
                    : [
                        isDark
                          ? "bg-blue-500 hover:bg-blue-400"
                          : "bg-blue-600 hover:bg-blue-700",
                      ]
                )}
                aria-label={`${o.siteName} へメッセージ`}
              >
                メッセージ
              </Link>
            </div>
          );
        })}
      </div>

      {/* 受信箱ボタン（ページ固定） */}
      <Link
        href="/community/message/inbox"
        aria-label="受信箱"
        className="fixed bottom-4 left-10 z-40 flex h-12 w-12 items-center justify-center rounded-full
                 bg-blue-600 text-white shadow-lg transition hover:bg-blue-700 focus:outline-none"
      >
        <Inbox className="h-6 w-6" />
      </Link>
    </main>
  );
}
