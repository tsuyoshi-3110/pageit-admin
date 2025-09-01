"use client";

import { useEffect, useState, useMemo } from "react";
import {
  collection,
  getDocs,
  updateDoc,
  doc,
  deleteDoc,
  Timestamp,
  query,
  where,
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
  Loader2,
  Mail,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Link as LinkIcon,
  Search,
  User,
  Phone,
  MapPin,
  AtSign,
} from "lucide-react";
import { useRouter as useNextRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import {
  credentialsEmailAtom,
  invEmailAtom,
  invOwnerNameAtom,
} from "@/lib/atoms/openFlagAtom";

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
};

type TransferLog = {
  id: string;
  email: string;
  collected?: boolean;
};

export default function SiteListPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [homepageInput, setHomepageInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [editSiteName, setEditSiteName] = useState("");
  const [editOwnerName, setEditOwnerName] = useState("");
  const [editOwnerPhone, setEditOwnerPhone] = useState("");
  const [editOwnerAddress, setEditOwnerAddress] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");

  const [transferLogMap, setTransferLogMap] = useState<
    Map<string, { collected: boolean }>
  >(new Map());

  const [credentialsSentMap, setCredentialsSentMap] = useState<
    Map<string, boolean>
  >(new Map());

  // ▼ 追加：フィルターモード
  type FilterMode = "all" | "paid" | "free" | "unpaid";
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

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

      const snap = await getDocs(collection(db, "siteSettings"));
      const rawList = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Site[];

      const listWithStatus: Site[] = await Promise.all(
        rawList.map(async (site) => {
          try {
            setLoading(true);
            const res = await fetch(
              `/api/stripe/check-subscription?siteKey=${site.id}`
            );
            const { status } = (await res.json()) as {
              status: PaymentStatus;
            };
            return { ...site, paymentStatus: status };
          } catch {
            return { ...site, paymentStatus: "none" };
          } finally {
            setLoading(false);
          }
        })
      );

      setSites(listWithStatus);

      // ログイン情報送信ログの取得
      await fetchCredentialsSentLogs();

      // 既存の transferLogs 読み込み
      const logs = await fetchTransferLogs();
      const map = mapTransferLogsByEmail(logs);
      setTransferLogMap(map);
    });

    return () => unsub();
  }, [router]);

  // 未払い扱いにするステータス（Stripeの代表的な未払い系も網羅）
  const UNPAID_STATUSES: PaymentStatus[] = [
    "none",
    "canceled",
    "past_due",
    "incomplete",
    "incomplete_expired",
    "unpaid",
  ];

  // カウント
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

  // ▼ 計は総件数
  const totalCount = useMemo(() => sites.length, [sites]);

  // ▼ フィルター済みリスト（モード + キーワード）
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

  // 無料プラン判定は paymentStatus ではなく isFreePlan を使用
  const renderCredentialsStatus = (
    email: string | undefined,
    isFreePlan: boolean,
    paymentStatus: PaymentStatus | undefined
  ) => {
    if (!email) return null;

    const isSent = credentialsSentMap.get(email) === true;
    const isPaidPlan =
      paymentStatus === "active" || paymentStatus === "pending_cancel";
    const isCollected = transferLogMap.get(email)?.collected === true;

    // 無料プラン＝常に表示 / 有料プラン＝集金済みのみ表示
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

  const fetchTransferLogs = async (): Promise<TransferLog[]> => {
    const snap = await getDocs(collection(db, "transferLogs"));
    return snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as TransferLog[];
  };

  const mapTransferLogsByEmail = (
    logs: TransferLog[]
  ): Map<string, { collected: boolean }> => {
    const map = new Map<string, { collected: boolean }>();
    logs.forEach((log) => {
      if (log.email) map.set(log.email, { collected: log.collected ?? false });
    });
    return map;
  };

  const updateCollectedStatus = async (email: string) => {
    const q = query(
      collection(db, "transferLogs"),
      where("email", "==", email)
    );
    const snap = await getDocs(q);
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
    map: Map<string, { collected: boolean }>,
    onClick: (email: string) => void
  ) => {
    if (!email) return null;
    const log = map.get(email);
    if (!log) return null;

    return log.collected ? (
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
    await updateDoc(doc(db, "siteSettings", siteId), {
      siteName: editSiteName,
      ownerName: editOwnerName,
      ownerPhone: editOwnerPhone,
      ownerAddress: editOwnerAddress,
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
            }
          : s
      )
    );
    setEditingInfoId(null);
  };

  // バッジ共通クラス
  const badgeBtn = (
    active: boolean,
    baseClasses: string,
    activeClasses: string
  ) =>
    clsx(
      "px-2 py-1 rounded font-medium border transition",
      active ? activeClasses : baseClasses
    );

  return (
    <div className="max-w-3xl mx-auto px-4 pt-10 space-y-4">
      {/* 上部サマリー */}
      <Card className="p-3 sticky top-16 z-20 bg-white/80 backdrop-blur">
        <div className="flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-bold">サイト一覧</h1>
          <div className="flex items-center gap-2 text-sm">
            {/* 有料 */}
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

            {/* 無料 */}
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

            {/* 未払い */}
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

            {/* 計（全件表示に戻す） */}
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

          return (
            <Card
              key={site.id}
              className={clsx(
                "p-4 shadow-sm rounded-xl border transition",
                isUnpaid
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
                  <div className="flex gap-2">
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
                      {site.isFreePlan && (
                        <span className="px-2 py-0.5 text-xs rounded bg-blue-500 text-white">
                          無料
                        </span>
                      )}
                      <h2 className="font-semibold text-lg truncate">
                        {site.siteName || "-"}
                      </h2>
                    </div>

                    <div className="flex items-center gap-2">
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
                      <User className="h-4 w-4 text-gray-500" />
                      <dt className="text-gray-500">オーナー</dt>
                      <dd className="ml-auto sm:ml-2 font-medium">
                        {site.ownerName || "-"}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-500" />
                      <dt className="text-gray-500">電話番号</dt>
                      <dd className="ml-auto sm:ml-2 font-medium">
                        {site.ownerPhone || "-"}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <MapPin className="h-4 w-4 text-gray-500" />
                      <dt className="text-gray-500">住所</dt>
                      <dd className="ml-auto sm:ml-2 font-medium truncate">
                        {site.ownerAddress || "-"}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <AtSign className="h-4 w-4 text-gray-500" />
                      <dt className="text-gray-500">メール</dt>
                      <dd className="ml-auto sm:ml-2 font-medium truncate">
                        {site.ownerEmail || "-"}
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
                            new Map(prev.set(email, { collected: true }))
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
                    className="cursor-pointer"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditingInfoId(site.id);
                      setEditSiteName(site.siteName);
                      setEditOwnerName(site.ownerName);
                      setEditOwnerPhone(site.ownerPhone);
                      setEditOwnerAddress(site.ownerAddress ?? "");
                    }}
                  >
                    ✏ オーナー情報を編集
                  </Button>

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
