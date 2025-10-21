// components/.../SiteListPage.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  Timestamp,
  updateDoc,
  where,
  setDoc, // ← 追加
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import clsx from "clsx";
import {
  AlertTriangle,
  AtSign,
  Briefcase,
  CheckCircle2,
  Link as LinkIcon,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Search,
  User,
  XCircle,
} from "lucide-react";
import { useRouter as useNextRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import {
  credentialsEmailAtom,
  invEmailAtom,
  invOwnerNameAtom,
} from "@/lib/atoms/openFlagAtom";

/* ───────── 業種オプション（RegisterPageと同一） ───────── */
type IndustryOption = { value: string; label: string };
const INDUSTRY_OPTIONS: IndustryOption[] = [
  { value: "food", label: "飲食" },
  { value: "retail", label: "小売" },
  { value: "beauty", label: "美容・サロン" },
  { value: "medical", label: "医療・介護" },
  { value: "construction", label: "建設・不動産" },
  { value: "it", label: "IT・ソフトウェア" },
  { value: "education", label: "教育・スクール" },
  { value: "logistics", label: "物流・運輸" },
  { value: "manufacturing", label: "製造" },
  { value: "professional", label: "士業" },
  { value: "service", label: "サービス" },
  { value: "other", label: "その他" },
];

/* ───────── 型 ───────── */
type PaymentStatus =
  | "active"
  | "pending_cancel"
  | "canceled"
  | "none"
  | "past_due"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

type Site = {
  id: string;
  siteName: string;
  ownerName: string;
  ownerPhone: string;
  ownerAddress?: string;
  ownerEmail?: string;
  homepageUrl?: string;
  cancelPending?: boolean;
  paymentStatus?: PaymentStatus;
  setupMode?: boolean;
  isFreePlan?: boolean;

  // 業種
  industry?: { key: string; name: string };

  // ロゴ（どちらかがあればOK）
  headerLogoUrl?: string; // 文字列URL
  headerLogo?: string | { url?: string }; // 文字列 or { url }
};

type TransferLog = {
  id: string;
  email: string;
  collected?: boolean;
  timestamp?: Date | Timestamp;
};

/* ───────── 料金系 ───────── */
const UNPAID_STATUSES: PaymentStatus[] = [
  "none",
  "canceled",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "unpaid",
];

/* ───────── ヘルパー ───────── */
function toJSDate(t?: Date | Timestamp): Date | undefined {
  if (!t) return undefined;
  if (t instanceof Timestamp) return t.toDate();
  if (t instanceof Date) return t;
  return undefined;
}
function daysAgoString(date?: Date): string {
  if (!date) return "-";
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return days <= 0 ? "本日" : `${days}日前`;
}
function formatYMD(date?: Date): string {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function SiteListPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);

  // URL 編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [homepageInput, setHomepageInput] = useState("");

  // 情報編集
  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [editSiteName, setEditSiteName] = useState("");
  const [editOwnerName, setEditOwnerName] = useState("");
  const [editOwnerPhone, setEditOwnerPhone] = useState("");
  const [editOwnerAddress, setEditOwnerAddress] = useState("");

  // 業種編集
  const [editIndustryKey, setEditIndustryKey] = useState<string>("");
  const [editIndustryOther, setEditIndustryOther] = useState<string>("");

  // 検索 & フィルタ
  type FilterMode = "all" | "paid" | "free" | "unpaid";
  const [searchKeyword, setSearchKeyword] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  // 集金・ログイン情報
  const [transferLogMap, setTransferLogMap] = useState<
    Map<string, { collected: boolean; lastSentAt?: Date }>
  >(new Map());
  const [credentialsSentMap, setCredentialsSentMap] = useState<
    Map<string, boolean>
  >(new Map());

  // ⬇ 送金停止トグル状態（siteSellers/{siteKey}.payoutsSuspended）
  const [payoutsSuspendedMap, setPayoutsSuspendedMap] = useState<
    Map<string, boolean>
  >(new Map());

  const setOwnerName = useSetAtom(invOwnerNameAtom);
  const setInvEmail = useSetAtom(invEmailAtom);
  const setEmail = useSetAtom(credentialsEmailAtom);

  const router = useRouter();
  const nextRouter = useNextRouter();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }
      setLoading(true);
      try {
        // base: siteSettings と editable: siteSettingsEditable を取得
        const [baseSnap, editableSnap] = await Promise.all([
          getDocs(collection(db, "siteSettings")),
          getDocs(collection(db, "siteSettingsEditable")).catch(() => null),
        ]);

        // editable 側のロゴ情報を map 化（key は doc.id 優先、無ければ data.siteKey）
        const editsLogoMap = new Map<
          string,
          { headerLogoUrl?: string; headerLogo?: string | { url?: string } }
        >();
        editableSnap?.docs.forEach((d) => {
          const data: any = d.data();
          const key = d.id || data?.siteKey;
          const urlCandidate =
            data?.headerLogoUrl ??
            (typeof data?.headerLogo === "object"
              ? data?.headerLogo?.url
              : data?.headerLogo);
          if (key) {
            editsLogoMap.set(key, {
              headerLogoUrl:
                typeof urlCandidate === "string" ? urlCandidate : undefined,
              headerLogo: data?.headerLogo ?? urlCandidate,
            });
          }
        });

        // ベース一覧に editable のロゴをマージ
        const baseList: Site[] = baseSnap.docs.map((d) => {
          const base = { id: d.id, ...d.data() } as Site;
          const extra = editsLogoMap.get(d.id) ?? null;
          return extra ? { ...base, ...extra } : base;
        });

        // Stripe ステータス付与
        const withStatus: Site[] = await Promise.all(
          baseList.map(async (site) => {
            try {
              const res = await fetch(
                `/api/stripe/check-subscription?siteKey=${site.id}`
              );
              const { status } = (await res.json()) as {
                status: PaymentStatus;
              };
              return { ...site, paymentStatus: status };
            } catch {
              return { ...site, paymentStatus: "none" };
            }
          })
        );

        setSites(withStatus);

        // ログイン情報送信ログ
        await fetchCredentialsSentLogs();

        // 集金ログ
        const logs = await fetchTransferLogs();
        setTransferLogMap(mapTransferLogsByEmail(logs));

        // ⬇ 送金停止トグルの読み込み（siteSellers）
        const sellersSnap = await getDocs(collection(db, "siteSellers")).catch(
          () => null
        );
        const pMap = new Map<string, boolean>();
        sellersSnap?.docs.forEach((d) => {
          const data: any = d.data();
          pMap.set(d.id, data?.payoutsSuspended === true);
        });
        setPayoutsSuspendedMap(pMap);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  const paidCount = useMemo(
    () =>
      sites.filter(
        (s) =>
          s.paymentStatus === "active" || s.paymentStatus === "pending_cancel"
      ).length,
    [sites]
  );
  const freeCount = useMemo(
    () => sites.filter((s) => s.isFreePlan === true).length,
    [sites]
  );
  const unpaidCount = useMemo(
    () =>
      sites.filter(
        (s) =>
          !s.isFreePlan &&
          s.paymentStatus &&
          UNPAID_STATUSES.includes(s.paymentStatus)
      ).length,
    [sites]
  );
  const totalCount = useMemo(() => sites.length, [sites]);

  /* ───────── フィルタ & 検索 ───────── */
  const filteredSites = sites
    .filter((site) => {
      switch (filterMode) {
        case "paid":
          return (
            site.paymentStatus === "active" ||
            site.paymentStatus === "pending_cancel"
          );
        case "free":
          return !!site.isFreePlan;
        case "unpaid":
          return (
            !site.isFreePlan &&
            !!site.paymentStatus &&
            UNPAID_STATUSES.includes(site.paymentStatus)
          );
        default:
          return true;
      }
    })
    .filter((site) => {
      const keyword = searchKeyword.toLowerCase();
      return (
        site.siteName?.toLowerCase().includes(keyword) ||
        site.ownerName?.toLowerCase().includes(keyword) ||
        site.ownerPhone?.toLowerCase().includes(keyword) ||
        site.ownerEmail?.toLowerCase().includes(keyword)
      );
    })
    .sort((a, b) => (a.ownerName ?? "").localeCompare(b.ownerName ?? "", "ja"));

  /* ───────── 小物関数（コンポーネント内に置く） ───────── */
  const renderSetupModeToggle = (
    siteId: string,
    current: boolean | undefined
  ) => {
    const toggleSetup = async () => {
      const newVal = !current;
      await updateDoc(doc(db, "siteSettings", siteId), {
        setupMode: newVal,
        updatedAt: Timestamp.now(),
      });
      setSites((prev) =>
        prev.map((s) => (s.id === siteId ? { ...s, setupMode: newVal } : s))
      );
    };

    return (
      <Button
        className="cursor-pointer"
        variant={current ? "default" : "outline"}
        size="sm"
        onClick={toggleSetup}
      >
        {current ? "✅ セットアップ中" : "セットアップモードにする"}
      </Button>
    );
  };

  const fetchCredentialsSentLogs = async () => {
    const snap = await getDocs(collection(db, "credentialsSentLogs"));
    const map = new Map<string, boolean>();
    snap.docs.forEach((doc) => {
      const { email } = doc.data() as { email?: string };
      if (email) map.set(email, true);
    });
    setCredentialsSentMap(map);
  };

  const fetchTransferLogs = async (): Promise<TransferLog[]> => {
    const snap = await getDocs(collection(db, "transferLogs"));
    return snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as TransferLog[];
  };

  const mapTransferLogsByEmail = (
    logs: TransferLog[]
  ): Map<string, { collected: boolean; lastSentAt?: Date }> => {
    const map = new Map<string, { collected: boolean; lastSentAt?: Date }>();
    logs.forEach((log) => {
      if (!log.email) return;
      const prev = map.get(log.email) ?? { collected: log.collected ?? false };
      const currentSentAt = toJSDate(log.timestamp);

      const next: { collected: boolean; lastSentAt?: Date } = {
        collected: prev.collected || false || (log.collected ?? false),
        lastSentAt: prev.lastSentAt,
      };
      if (currentSentAt) {
        if (!prev.lastSentAt || currentSentAt > prev.lastSentAt) {
          next.lastSentAt = currentSentAt;
        }
      }
      map.set(log.email, next);
    });
    return map;
  };

  const updateCollectedStatus = async (email: string) => {
    const q_ = query(
      collection(db, "transferLogs"),
      where("email", "==", email)
    );
    const snap = await getDocs(q_);
    for (const docRef of snap.docs) {
      await updateDoc(docRef.ref, { collected: true });
    }
  };

  const handleSendCredentials = (email: string) => {
    setEmail(email);
    nextRouter.push(`/send-credentials`);
  };

  const handleSendInv = (email: string, name: string) => {
    setInvEmail(email);
    setOwnerName(name);
    nextRouter.push(`/send-transfer`);
  };

  const renderTransferStatus = (
    email: string | undefined,
    map: Map<string, { collected: boolean; lastSentAt?: Date }>,
    onClick: (email: string) => void
  ) => {
    if (!email) return null;
    const info = map.get(email);
    if (!info) return null;

    return (
      <div className="flex items-center gap-2">
        {info.collected ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded text-xs font-medium">
            <CheckCircle2 size={14} />
            集金済み
          </span>
        ) : (
          <Button
            className="cursor-pointer"
            size="sm"
            variant="outline"
            onClick={() => onClick(email)}
          >
            💰 集金確認
          </Button>
        )}

        {info.lastSentAt && !info.collected && (
          <span
            className="inline-flex items-center gap-1 text-violet-700 bg-violet-100 px-2 py-0.5 rounded text-xs font-medium"
            title={`最終送信日：${formatYMD(info.lastSentAt)}`}
          >
            📅 送信 {daysAgoString(info.lastSentAt)}
          </span>
        )}
      </div>
    );
  };

  // ✅ ログイン情報送信ステータス
  const renderCredentialsStatus = (
    email: string | undefined,
    isFreePlan: boolean,
    paymentStatus: PaymentStatus | undefined
  ) => {
    if (!email) return null;

    const isSent = credentialsSentMap.get(email) === true;
    const isPaidPlan =
      paymentStatus === "active" || paymentStatus === "pending_cancel";

    // 無料プラン＝常に表示 / 有料プラン＝集金済みのみ表示
    const isCollected = transferLogMap.get(email)?.collected === true;
    if (!isFreePlan && !(isPaidPlan && isCollected)) return null;

    return (
      <div className="flex items-center gap-2">
        {isSent && (
          <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-100 px-2 py-0.5 rounded text-xs font-medium">
            <Mail size={14} />
            ログイン情報送信済み
          </span>
        )}
        <Button
          className="cursor-pointer"
          size="sm"
          variant="default"
          onClick={() => handleSendCredentials(email)}
        >
          <Mail className="mr-1.5 h-4 w-4" />
          ログイン情報送信
        </Button>
      </div>
    );
  };

  const handleSave = async (siteId: string) => {
    await updateDoc(doc(db, "siteSettings", siteId), {
      homepageUrl: homepageInput,
      updatedAt: Timestamp.now(),
    });
    setSites((prev) =>
      prev.map((s) =>
        s.id === siteId ? { ...s, homepageUrl: homepageInput } : s
      )
    );
    setEditingId(null);
    setHomepageInput("");
  };

  const handleCancel = async (siteId: string) => {
    if (!confirm("本当に解約しますか？次回請求以降課金されません。")) return;
    const res = await fetch("/api/stripe/cancel-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteKey: siteId }),
    });
    if (!res.ok) return alert("解約に失敗しました");
    setSites((p) =>
      p.map((s) => (s.id === siteId ? { ...s, cancelPending: true } : s))
    );
  };

  const handleDelete = async (siteId: string) => {
    if (!confirm("本当にこのサイトを削除しますか？この操作は取り消せません。"))
      return;
    try {
      await deleteDoc(doc(db, "siteSettings", siteId));
      setSites((prev) => prev.filter((s) => s.id !== siteId));
    } catch (error) {
      console.error("削除エラー:", error);
      alert("削除に失敗しました。");
    }
  };

  const handleUpdateInfo = async (siteId: string) => {
    const industryName =
      editIndustryKey === "other"
        ? editIndustryOther.trim()
        : INDUSTRY_OPTIONS.find((o) => o.value === editIndustryKey)?.label ||
          "";

    await updateDoc(doc(db, "siteSettings", siteId), {
      siteName: editSiteName,
      ownerName: editOwnerName,
      ownerPhone: editOwnerPhone,
      ownerAddress: editOwnerAddress,
      industry: editIndustryKey
        ? { key: editIndustryKey, name: industryName }
        : null,
      updatedAt: Timestamp.now(),
    });

    setSites((prev) =>
      prev.map((s) =>
        s.id === siteId
          ? {
              ...s,
              siteName: editSiteName,
              ownerName: editOwnerName,
              ownerPhone: editOwnerPhone,
              ownerAddress: editOwnerAddress,
              industry: editIndustryKey
                ? { key: editIndustryKey, name: industryName }
                : undefined,
            }
          : s
      )
    );
    setEditingInfoId(null);
  };

  // ⬇ 送金停止トグルの更新
  const handleTogglePayouts = async (siteId: string, next: boolean) => {
    await setDoc(
      doc(db, "siteSellers", siteId),
      { payoutsSuspended: next, updatedAt: Timestamp.now() },
      { merge: true }
    );
    setPayoutsSuspendedMap((prev) => new Map(prev.set(siteId, next)));
  };

  const badgeBtn = (
    active: boolean,
    baseClasses: string,
    activeClasses: string
  ) =>
    clsx(
      "px-2 py-1 rounded font-medium border transition",
      active ? activeClasses : baseClasses
    );

  const handleReleasePayouts = async (siteId: string, force = true) => {
    try {
      const res = await fetch("/api/payouts/release-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: siteId, force, limit: 50 }), // 必要なら件数調整
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        alert(`送金に失敗しました (${res.status})\n${t}`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      alert(
        `送金完了: ${data.released ?? 0} 件 / スキップ ${data.skipped ?? 0} 件`
      );
    } catch (e) {
      alert(`送金APIエラー: ${String(e)}`);
    }
  };

  /* ───────── Render ───────── */
  return (
    <div className="max-w-3xl mx-auto px-4 pt-10 space-y-4">
      {/* 上部サマリー */}
      <Card className="p-3 sticky top-16 z-20 bg-white/80 backdrop-blur">
        <div className="flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-bold">サイト一覧</h1>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() =>
                setFilterMode((m) => (m === "paid" ? "all" : "paid"))
              }
              className={badgeBtn(
                filterMode === "paid",
                "bg-emerald-100 text-emerald-700 border-emerald-200",
                "bg-emerald-600 text-white border-emerald-700"
              )}
              title={filterMode === "paid" ? "フィルター解除" : "有料のみ表示"}
            >
              有料 {paidCount}
            </button>

            <button
              type="button"
              onClick={() =>
                setFilterMode((m) => (m === "free" ? "all" : "free"))
              }
              className={badgeBtn(
                filterMode === "free",
                "bg-blue-100 text-blue-700 border-blue-200",
                "bg-blue-600 text-white border-blue-700"
              )}
              title={filterMode === "free" ? "フィルター解除" : "無料のみ表示"}
            >
              無料 {freeCount}
            </button>

            <button
              type="button"
              onClick={() =>
                setFilterMode((m) => (m === "unpaid" ? "all" : "unpaid"))
              }
              className={badgeBtn(
                filterMode === "unpaid",
                "bg-amber-100 text-amber-700 border-amber-200",
                "bg-amber-600 text-white border-amber-700"
              )}
              title={
                filterMode === "unpaid" ? "フィルター解除" : "未払いのみ表示"
              }
            >
              未払い {unpaidCount}
            </button>

            <button
              type="button"
              onClick={() => setFilterMode("all")}
              className={badgeBtn(
                filterMode === "all",
                "bg-gray-100 text-gray-700 border-gray-200",
                "bg-gray-700 text-white border-gray-800"
              )}
              title="全件表示"
            >
              計 {totalCount}
            </button>
          </div>
        </div>

        {/* 検索 */}
        <div className="mt-3 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            type="text"
            placeholder={`${
              filterMode === "all"
                ? ""
                : `（${
                    filterMode === "paid"
                      ? "有料"
                      : filterMode === "free"
                      ? "無料"
                      : "未払い"
                  }のみ）`
            }名前・電話・メールで検索`}
            className="pl-9"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
        </div>
      </Card>

      {loading && (
        <div className="flex justify-center items-start min-h-[40vh] pt-16">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && filteredSites.length === 0 && (
        <Card className="p-6 text-center text-sm text-gray-600">
          条件に一致するサイトがありません。
        </Card>
      )}

      {!loading &&
        filteredSites.map((site) => {
          const isPending =
            site.cancelPending === true ||
            site.paymentStatus === "pending_cancel";
          const isCanceled = site.paymentStatus === "canceled";
          const isPaid = site.paymentStatus === "active";
          const isUnpaid =
            !site.isFreePlan &&
            !!site.paymentStatus &&
            UNPAID_STATUSES.includes(site.paymentStatus);

          const industryDisplay =
            (site.industry?.name && site.industry.name.trim()) ||
            (site.industry?.key
              ? INDUSTRY_OPTIONS.find((o) => o.value === site.industry!.key)
                  ?.label || ""
              : "") ||
            "-";

          // ロゴURLを決定
          const logoSrc =
            site.headerLogoUrl ||
            (typeof site.headerLogo === "object"
              ? site.headerLogo?.url
              : undefined) ||
            (typeof site.headerLogo === "string"
              ? site.headerLogo
              : undefined) ||
            null;

          // ⬇ 販売者ドキュメント有無と停止状態を判定
          const hasSeller = payoutsSuspendedMap.has(site.id);
          const suspended =
            hasSeller && payoutsSuspendedMap.get(site.id) === true;

          return (
            <Card
              key={site.id}
              className={clsx(
                "p-4 shadow-sm rounded-xl border transition",
                suspended
                  ? "border-rose-300 bg-rose-50/40"
                  : isUnpaid
                  ? "border-amber-300 bg-amber-50/40"
                  : isPending
                  ? "border-yellow-300 bg-yellow-50/30"
                  : isCanceled
                  ? "border-gray-200 bg-gray-50"
                  : isPaid
                  ? "border-emerald-200 bg-emerald-50/30"
                  : "border-slate-200"
              )}
            >
              {editingInfoId === site.id ? (
                <div className="space-y-2">
                  <Input
                    placeholder="サイト名"
                    value={editSiteName}
                    onChange={(e) => setEditSiteName(e.target.value)}
                  />
                  <Input
                    placeholder="オーナー名"
                    value={editOwnerName}
                    onChange={(e) => setEditOwnerName(e.target.value)}
                  />
                  <Input
                    placeholder="電話番号"
                    value={editOwnerPhone}
                    onChange={(e) => setEditOwnerPhone(e.target.value)}
                  />
                  <Input
                    placeholder="住所"
                    value={editOwnerAddress}
                    onChange={(e) => setEditOwnerAddress(e.target.value)}
                  />
                  <Input value={site.ownerEmail ?? ""} disabled />

                  {/* 業種（RegisterPageと同じUI） */}
                  <div className="space-y-2 pt-1">
                    <label className="text-sm text-gray-700">業種</label>
                    <select
                      value={editIndustryKey}
                      onChange={(e) => setEditIndustryKey(e.target.value)}
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    >
                      <option value="" disabled>
                        選択してください
                      </option>
                      {INDUSTRY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>

                    {editIndustryKey === "other" && (
                      <Input
                        type="text"
                        placeholder="その他の業種を入力"
                        value={editIndustryOther}
                        onChange={(e) => setEditIndustryOther(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <Button onClick={() => handleUpdateInfo(site.id)}>
                      保存
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setEditingInfoId(null)}
                    >
                      キャンセル
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* タイトル行 */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {logoSrc && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={logoSrc}
                          alt=""
                          className="h-8 w-8 rounded bg-white object-contain border border-gray-200"
                          onError={(e) => {
                            (
                              e.currentTarget as HTMLImageElement
                            ).style.display = "none";
                          }}
                        />
                      )}
                      {site.isFreePlan && (
                        <span className="px-2 py-0.5 text-xs rounded bg-blue-500 text-white">
                          無料
                        </span>
                      )}
                      {/* ⬇ EC バッジ（siteSellers にドキュメントがある場合のみ） */}
                      {hasSeller && (
                        <span className="px-2 py-0.5 text-xs rounded bg-violet-600 text-white">
                          EC
                        </span>
                      )}
                      <h2 className="font-semibold text-lg truncate">
                        {site.siteName || "-"}
                      </h2>
                    </div>

                    <div className="flex items-center gap-2">
                      {suspended && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-rose-600 text-white">
                          <AlertTriangle size={14} />
                          送金停止中
                        </span>
                      )}
                      {hasSeller && (
                        <Button
                          className="cursor-pointer"
                          size="sm"
                          variant="default"
                          onClick={() => handleReleasePayouts(site.id, true)} // 期限前でも送金するなら true
                        >
                          送金する
                        </Button>
                      )}
                      {isPending && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-yellow-500 text-white">
                          解約予約
                        </span>
                      )}
                      {isCanceled && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-gray-500 text-white">
                          <XCircle size={14} />
                          解約済み
                        </span>
                      )}
                      {isUnpaid && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-amber-600 text-white">
                          <AlertTriangle size={14} />
                          サブスク未払い
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 詳細 */}
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-2 text-sm">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <dt className="text-gray-600 dark:text-gray-300">
                        オーナー
                      </dt>
                      <dd className="ml-auto sm:ml-2 font-medium text-gray-900 dark:text-gray-100">
                        {site.ownerName || "-"}
                      </dd>
                    </div>

                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <dt className="text-gray-600 dark:text-gray-300">
                        電話番号
                      </dt>
                      <dd className="ml-auto sm:ml-2 font-medium text-gray-900 dark:text-gray-100">
                        {site.ownerPhone || "-"}
                      </dd>
                    </div>

                    <div className="flex items-center gap-2 sm:col-span-2">
                      <MapPin className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <dt className="text-gray-600 dark:text-gray-300">住所</dt>
                      <dd className="ml-auto sm:ml-2 font-medium text-gray-900 dark:text-gray-100 truncate">
                        {site.ownerAddress || "-"}
                      </dd>
                    </div>

                    <div className="flex items-center gap-2 sm:col-span-2">
                      <AtSign className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <dt className="text-gray-600 dark:text-gray-300">
                        メール
                      </dt>
                      <dd className="ml-auto sm:ml-2 font-medium text-gray-900 dark:text-gray-100 truncate">
                        {site.ownerEmail || "-"}
                      </dd>
                    </div>

                    {/* 業種表示 */}
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <Briefcase className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <dt className="text-gray-600 dark:text-gray-300">業種</dt>
                      <dd className="ml-auto sm:ml-2 font-medium text-gray-900 dark:text-gray-100 truncate">
                        {industryDisplay}
                      </dd>
                    </div>
                  </dl>

                  {/* 集金/ログイン情報 */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {renderTransferStatus(
                      site.ownerEmail,
                      transferLogMap,
                      async (email) => {
                        await updateCollectedStatus(email);
                        setTransferLogMap(
                          (prev) =>
                            new Map(
                              prev.set(email, {
                                ...(prev.get(email) ?? {
                                  lastSentAt: undefined,
                                }),
                                collected: true,
                              })
                            )
                        );
                      }
                    )}

                    {renderCredentialsStatus(
                      site.ownerEmail,
                      !!site.isFreePlan,
                      site.paymentStatus
                    )}
                  </div>
                </>
              )}

              {/* 外部リンク */}
              {site.homepageUrl && (
                <div className="mt-3">
                  <a
                    href={site.homepageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 underline decoration-1 underline-offset-2"
                  >
                    <LinkIcon className="h-4 w-4" />
                    ホームページを開く
                  </a>
                </div>
              )}

              {/* フッター操作群 */}
              {editingId === site.id ? (
                <div className="mt-3 space-y-2">
                  <Input
                    type="url"
                    placeholder="https://..."
                    value={homepageInput}
                    onChange={(e) => setHomepageInput(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="cursor-pointer"
                      onClick={() => handleSave(site.id)}
                    >
                      保存
                    </Button>
                    <Button
                      className="cursor-pointer"
                      variant="outline"
                      onClick={() => {
                        setEditingId(null);
                        setHomepageInput("");
                      }}
                    >
                      キャンセル
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2 flex-wrap">
                  <Button
                    className="cursor-pointer"
                    size="sm"
                    onClick={() => {
                      setEditingId(site.id);
                      setHomepageInput(site.homepageUrl ?? "");
                    }}
                  >
                    {site.homepageUrl ? "✏️ URLを編集" : "＋ URLを追加"}
                  </Button>

                  {renderSetupModeToggle(site.id, site.setupMode)}

                  <Button
                    className="cursor-pointer bg-orange-500 hover:bg-orange-600 text-white focus-visible:ring-2 focus-visible:ring-orange-500"
                    size="sm"
                    variant="default"
                    onClick={() => {
                      setEditingInfoId(site.id);
                      setEditSiteName(site.siteName);
                      setEditOwnerName(site.ownerName);
                      setEditOwnerPhone(site.ownerPhone);
                      setEditOwnerAddress(site.ownerAddress ?? "");
                      const k = site.industry?.key ?? "";
                      setEditIndustryKey(k);
                      setEditIndustryOther(
                        k === "other" ? site.industry?.name ?? "" : ""
                      );
                    }}
                  >
                    ✏ オーナー情報を編集
                  </Button>

                  {/* ⬇ 送金停止 / 再送 トグル（siteSellers にドキュメントがある場合のみ表示） */}
                  {hasSeller && (
                    <Button
                      className="cursor-pointer"
                      size="sm"
                      variant={suspended ? "default" : "outline"}
                      onClick={() => handleTogglePayouts(site.id, !suspended)}
                    >
                      {suspended ? "再送" : "送金停止"}
                    </Button>
                  )}

                  {isPaid && !isPending && (
                    <Button
                      className="cursor-pointer"
                      size="sm"
                      variant="destructive"
                      onClick={() => handleCancel(site.id)}
                    >
                      サブスク解約
                    </Button>
                  )}

                  <Button
                    className="cursor-pointer"
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(site.id)}
                  >
                    firebaseアカウント削除
                  </Button>

                  {site.paymentStatus === "none" &&
                    !site.isFreePlan &&
                    site.ownerEmail && (
                      <Button
                        className="cursor-pointer"
                        size="sm"
                        variant="default"
                        onClick={() =>
                          handleSendInv(
                            site.ownerEmail ?? "noName",
                            site.ownerName ?? "noName"
                          )
                        }
                      >
                        📩 請求書送信
                      </Button>
                    )}
                </div>
              )}
            </Card>
          );
        })}
    </div>
  );
}
