// components/.../SiteListPage.tsx
"use client";

import { authedFetch } from "@/lib/authedFetch";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  Timestamp,
  updateDoc,
  where,
  setDoc,
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

import {
  type Site,
  type PaymentStatus,
  type TransferLog,
} from "@/lib/type/siteListType";
import { toJSDate, daysAgoString, formatYMD } from "@/lib/siteListHellper";
import SiteListSearcher, {
  filterSites,
} from "@/components/siteList/siteListSearcher";
import LoadingOverlay from "@/components/common/LoadingOverlah";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type OrderDoc = {
  id: string;
  siteKey: string;
  amount: number; // JPY
  currency?: string; // "jpy" など
  paymentIntentId?: string; // 返金に必須
  status?: "completed" | "refunded" | string;
  refunded?: boolean;
  refundId?: string | null;
  refundAt?: Date | null;
  customer?: { name?: string; email?: string };
  createdAt?: any; // Timestamp
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

export default function SiteListPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);

  // グローバル・ローディング（真ん中に出す）
  const [loadingOverlay, setLoadingOverlay] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);

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

  // 送金停止トグル（siteSellers/{siteKey}.payoutsSuspended）
  const [payoutsSuspendedMap, setPayoutsSuspendedMap] = useState<
    Map<string, boolean>
  >(new Map());

  // 🔧 エスクロー保留日数（全サイト共通・管理画面で編集）
  const [holdDays, setHoldDays] = useState<number | null>(null);
  const [savingHold, setSavingHold] = useState(false);
  const [ordersOpenFor, setOrdersOpenFor] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderDoc[]>([]);
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundAmountMap, setRefundAmountMap] = useState<
    Record<string, number>
  >({});

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

        // editable 側のロゴ情報を map 化
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
              const res = await authedFetch(`/api/stripe/check-subscription?siteKey=${site.id}`
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

        // 送金停止トグルの読み込み（siteSellers）
        const sellersSnap = await getDocs(collection(db, "siteSellers")).catch(
          () => null
        );
        const pMap = new Map<string, boolean>();
        sellersSnap?.docs.forEach((d) => {
          const data: any = d.data();
          pMap.set(d.id, data?.payoutsSuspended === true);
        });
        setPayoutsSuspendedMap(pMap);

        // 🔧 グローバル保留日数の読込
        const gSnap = await getDoc(doc(db, "adminSettings", "global"));
        const v = Number(gSnap.data()?.payoutHoldDays ?? 30);
        const clamped = Number.isFinite(v) ? Math.max(0, Math.min(90, v)) : 30;
        setHoldDays(clamped);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  const jpy = (n: number | undefined) =>
    typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "-";

  async function handleRefund(order: OrderDoc) {
    if (!order.paymentIntentId) {
      alert("この注文には paymentIntentId がありません。返金できません。");
      return;
    }
    const full = Number(order.amount || 0);
    const reqAmount = Number(refundAmountMap[order.id] ?? full);
    if (!Number.isInteger(reqAmount) || reqAmount <= 0 || reqAmount > full) {
      alert(
        "返金額が不正です。0より大きく、注文金額以下の整数（円）で指定してください。"
      );
      return;
    }

    if (
      !confirm(`返金しますか？\n注文ID: ${order.id}\n返金額: ${jpy(reqAmount)}`)
    ) {
      return;
    }

    setRefundingId(order.id);
    try {
      const user = auth.currentUser;
      const token = user ? await user.getIdToken() : null;
      if (!token) {
        alert("未ログインのため返金できません。");
        return;
      }

      const res = await fetch("/api/refunds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId: order.id,
          siteKey: order.siteKey,
          paymentIntentId: order.paymentIntentId,
          amount: reqAmount, // 未指定ならサーバーで全額
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      // 反映（サーバー側でも更新済み。ここはUI同期）
      setOrders((prev) =>
        prev.map((o) =>
          o.id === order.id
            ? {
                ...o,
                refunded: true,
                status: "refunded",
                refundId: data.refund?.id ?? o.refundId ?? null,
                refundAt: new Date(),
              }
            : o
        )
      );
      alert("返金が完了しました。");
    } catch (e: any) {
      console.error(e);
      alert("返金に失敗しました: " + (e?.message || String(e)));
    } finally {
      setRefundingId(null);
    }
  }

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
  const filteredSites = useMemo(() => {
    const out = filterSites(sites, filterMode, searchKeyword);
    return out.sort((a, b) =>
      (a.ownerName ?? "").localeCompare(b.ownerName ?? "", "ja")
    );
  }, [sites, filterMode, searchKeyword]);

  /* ───────── 小物関数 ───────── */
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

  // 既存: 送金停止トグルの更新（再送に戻したら期日分を即時送金）
  const handleTogglePayouts = async (siteId: string, next: boolean) => {
    await setDoc(
      doc(db, "siteSellers", siteId),
      { payoutsSuspended: next, ecStop: next, updatedAt: Timestamp.now() },
      { merge: true }
    );
    setPayoutsSuspendedMap((prev) => new Map(prev.set(siteId, next)));

    if (!next) {
      try {
        setLoadingMessage("期日分を即時送金中…");
        setLoadingProgress(null);
        setLoadingOverlay(true);

        const res = await authedFetch("/api/payouts/release-site", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteKey: siteId, force: false, limit: 100 }),
        });

        let j: any = {};
        try {
          j = await res.json();
        } catch {}

        if (!res.ok) {
          alert(`期日分の即時送金に失敗しました (${res.status})`);
        } else {
          alert(
            `期日分を即時送金：${j.released ?? 0} 件（スキップ ${
              j.skipped ?? 0
            }, 失敗 ${j.failed ?? 0}）`
          );
        }
      } catch (e) {
        alert(`期日分の即時送金APIエラー: ${String(e)}`);
      } finally {
        setLoadingOverlay(false);
        setLoadingMessage("");
        setLoadingProgress(null);
      }
    }
  };

  // 🔸 送金API（force: true=期日前も含め全額 / false=期日到来分のみ）
  const handleReleasePayouts = async (siteId: string, force = true) => {
    setLoadingMessage(force ? "全額送金中…" : "期日分を送金中…");
    setLoadingProgress(null);
    setLoadingOverlay(true);
    try {
      const res = await authedFetch("/api/payouts/release-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: siteId, force, limit: 50 }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        alert(`送金に失敗しました (${res.status})\n${t}`);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(
          `送金完了: ${data.released ?? 0} 件 / スキップ ${
            data.skipped ?? 0
          } 件 / 失敗 ${data.failed ?? 0} 件`
        );
      }
    } catch (e) {
      alert(`送金APIエラー: ${String(e)}`);
    } finally {
      setLoadingOverlay(false);
      setLoadingMessage("");
      setLoadingProgress(null);
    }
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

  // --- ここから: 4つのハンドラ ---

  async function handleSave(siteId: string) {
    setLoadingMessage("URLを保存中…");
    setLoadingProgress(null);
    setLoadingOverlay(true);

    try {
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
    } catch (e) {
      console.error("handleSave error:", e);
      alert("URLの保存に失敗しました。");
    } finally {
      setLoadingOverlay(false);
      setLoadingMessage("");
      setLoadingProgress(null);
    }
  }

  async function handleCancel(siteId: string) {
    if (!confirm("本当に解約しますか？次回請求以降課金されません。")) return;
    try {
      const res = await authedFetch("/api/stripe/cancel-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: siteId }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSites((p) =>
        p.map((s) => (s.id === siteId ? { ...s, cancelPending: true } : s))
      );
    } catch (e) {
      console.error("handleCancel error:", e);
      alert("解約に失敗しました。");
    }
  }

  async function handleDelete(siteId: string) {
    if (!confirm("本当にこのサイトを削除しますか？この操作は取り消せません。"))
      return;
    try {
      await deleteDoc(doc(db, "siteSettings", siteId));
      setSites((prev) => prev.filter((s) => s.id !== siteId));
    } catch (e) {
      console.error("handleDelete error:", e);
      alert("削除に失敗しました。");
    }
  }

  async function handleUpdateInfo(siteId: string) {
    setLoadingMessage("オーナー情報を保存中…");
    setLoadingProgress(null);
    setLoadingOverlay(true);

    try {
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
    } catch (e) {
      console.error("handleUpdateInfo error:", e);
      alert("保存に失敗しました。");
    } finally {
      setLoadingOverlay(false);
      setLoadingMessage("");
      setLoadingProgress(null);
    }
  }

  // --- ここまで: 4つのハンドラ ---

  /* ───────── Render ───────── */
  return (
    <div className="max-w-3xl mx-auto px-4 pt-10 space-y-4">
      <LoadingOverlay
        open={loadingOverlay}
        message={loadingMessage || "処理中…"}
        progress={loadingProgress}
      />

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
        <SiteListSearcher
          filterMode={filterMode}
          searchKeyword={searchKeyword}
          setSearchKeyword={setSearchKeyword}
        />
      </Card>

      {/* 🔧 エスクロー保留日数の設定カード（全サイト共通） */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="font-medium">エスクロー保留日数（全サイト共通）</div>
          <Input
            type="number"
            min={0}
            max={90}
            className="w-28 text-right pr-2"
            value={holdDays ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              setHoldDays(Number.isFinite(n) ? n : 0);
            }}
          />
          <Button
            disabled={holdDays === null || savingHold}
            onClick={async () => {
              if (holdDays === null) return;
              setSavingHold(true);
              try {
                const clamped = Math.max(0, Math.min(90, Math.floor(holdDays)));
                await setDoc(
                  doc(db, "adminSettings", "global"),
                  { payoutHoldDays: clamped, updatedAt: Timestamp.now() },
                  { merge: true }
                );
                alert("保留日数を保存しました（新規決済から適用）");
              } finally {
                setSavingHold(false);
              }
            }}
          >
            {savingHold ? "保存中..." : "保存"}
          </Button>
          <div className="text-xs text-gray-500">
            ※既存の保留中エスクローには影響しません（releaseAt 固定）。
          </div>
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

          const logoSrc =
            site.headerLogoUrl ||
            (typeof site.headerLogo === "object"
              ? site.headerLogo?.url
              : undefined) ||
            (typeof site.headerLogo === "string"
              ? site.headerLogo
              : undefined) ||
            null;

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

                  {/* 業種 */}
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
                      {/* EC バッジ（siteSellers にドキュメントがある場合のみ） */}
                      {hasSeller && (
                        <span className="px-2 py-0.5 text-xs rounded bg-violet-600 text-white">
                          EC
                        </span>
                      )}
                      {hasSeller && (
                        <div className="mt-3">
                          <Button
                            className="cursor-pointer"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              nextRouter.push(`/orders/${site.id}`)
                            }
                          >
                            購入履歴
                          </Button>
                        </div>
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
                    {/* 集金ログ表示 */}
                    <div className="flex items-center gap-2">
                      {(() => {
                        const email = site.ownerEmail;
                        if (!email) return null;
                        const info = transferLogMap.get(email);
                        if (!info) return null;
                        return (
                          <>
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
                                onClick={async () => {
                                  await updateCollectedStatus(email);
                                  setTransferLogMap((prev) => {
                                    const next = new Map(prev);
                                    const cur = next.get(email);
                                    next.set(email, {
                                      ...(cur ?? {}),
                                      collected: true,
                                    });
                                    return next;
                                  });
                                }}
                              >
                                💰 集金確認
                              </Button>
                            )}
                            {info.lastSentAt && !info.collected && (
                              <span
                                className="inline-flex items-center gap-1 text-violet-700 bg-violet-100 px-2 py-0.5 rounded text-xs font-medium"
                                title={`最終送信日：${formatYMD(
                                  info.lastSentAt
                                )}`}
                              >
                                📅 送信 {daysAgoString(info.lastSentAt)}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>

                    {/* ログイン情報送信 */}
                    {(() => {
                      const email = site.ownerEmail;
                      if (!email) return null;
                      const isSent = credentialsSentMap.get(email) === true;
                      const isPaidPlan =
                        site.paymentStatus === "active" ||
                        site.paymentStatus === "pending_cancel";
                      const isCollected =
                        transferLogMap.get(email)?.collected === true;
                      if (!site.isFreePlan && !(isPaidPlan && isCollected))
                        return null;

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
                    })()}
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

                  {/* セットアップモード */}
                  <Button
                    className="cursor-pointer"
                    variant={site.setupMode ? "default" : "outline"}
                    size="sm"
                    onClick={async () => {
                      const newVal = !site.setupMode;
                      await updateDoc(doc(db, "siteSettings", site.id), {
                        setupMode: newVal,
                        updatedAt: Timestamp.now(),
                      });
                      setSites((prev) =>
                        prev.map((s) =>
                          s.id === site.id ? { ...s, setupMode: newVal } : s
                        )
                      );
                    }}
                  >
                    {site.setupMode
                      ? "✅ セットアップ中"
                      : "セットアップモードにする"}
                  </Button>

                  {/* サブスク解約 */}
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

                  {/* Firestore 削除 */}
                  <Button
                    className="cursor-pointer"
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(site.id)}
                  >
                    firebaseアカウント削除
                  </Button>

                  {/* 請求書送信（未契約のみ） */}
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

              {/* 送金操作ブロック（常に横並び） */}
              {hasSeller && (
                <div className="mt-3 inline-flex items-center gap-2 whitespace-nowrap">
                  <Button
                    className="cursor-pointer shrink-0"
                    size="sm"
                    variant={suspended ? "default" : "outline"}
                    onClick={() => handleTogglePayouts(site.id, !suspended)}
                  >
                    {suspended ? "再送" : "送金停止"}
                  </Button>

                  <Button
                    className="cursor-pointer shrink-0"
                    size="sm"
                    variant="outline"
                    title="期日到来分のみ送金"
                    onClick={() => handleReleasePayouts(site.id, false)}
                  >
                    期日分を送金
                  </Button>

                  <Button
                    className="cursor-pointer shrink-0"
                    size="sm"
                    variant="default"
                    title="保留中をすべて送金（期日前を含む）"
                    onClick={() => {
                      if (
                        confirm(
                          "期日前の保留分も含めて送金します。よろしいですか？"
                        )
                      ) {
                        handleReleasePayouts(site.id, true);
                      }
                    }}
                  >
                    送金する（全額）
                  </Button>
                </div>
              )}
            </Card>
          );
        })}

      <Dialog
        open={!!ordersOpenFor}
        onOpenChange={(open) => !open && setOrdersOpenFor(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>購入履歴</DialogTitle>
          </DialogHeader>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>購入者</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>PI</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead className="text-right">返金</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const created =
                    o.createdAt instanceof Date
                      ? o.createdAt
                      : o.createdAt?.toDate?.() ?? null;
                  const canRefund = !!o.paymentIntentId && !o.refunded;
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="whitespace-nowrap">
                        {created ? created.toLocaleString("ja-JP") : "-"}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate">
                        {o.customer?.name || o.customer?.email || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {jpy(o.amount)}
                      </TableCell>
                      <TableCell
                        className="max-w-[180px] truncate"
                        title={o.paymentIntentId}
                      >
                        {o.paymentIntentId ?? "-"}
                      </TableCell>
                      <TableCell>
                        {o.refunded ? (
                          <span className="px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-700">
                            返金済
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700">
                            購入済
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canRefund ? (
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              type="number"
                              className="w-24 text-right"
                              value={refundAmountMap[o.id] ?? o.amount ?? 0}
                              min={1}
                              max={o.amount ?? 0}
                              onChange={(e) =>
                                setRefundAmountMap((m) => ({
                                  ...m,
                                  [o.id]: Number(e.target.value || 0),
                                }))
                              }
                            />
                            <Button
                              size="sm"
                              disabled={refundingId === o.id}
                              onClick={() => handleRefund(o)}
                            >
                              {refundingId === o.id ? "返金中…" : "返金"}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-500">
                            {o.refunded ? "—" : "PIなし"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOrdersOpenFor(null)}>
              閉じる
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
