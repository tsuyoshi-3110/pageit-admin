"use client";

import { useEffect, useState } from "react";
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
import { Loader2 } from "lucide-react";
import { useRouter as useNextRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import {
  credentialsEmailAtom,
  invEmailAtom,
  invOwnerNameAtom,
} from "@/lib/atoms/openFlagAtom";

/* ───────── 型 ───────── */
type Site = {
  id: string;
  siteName: string;
  ownerName: string;
  ownerPhone: string;
  ownerAddress?: string;
  ownerEmail?: string;
  homepageUrl?: string;
  cancelPending?: boolean;
  paymentStatus?: "active" | "pending_cancel" | "canceled" | "none";
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
              status: Site["paymentStatus"];
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

  const filteredSites = sites
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

      // 再取得またはstate更新
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
      const { email } = doc.data();
      if (email) {
        map.set(email, true);
      }
    });
    setCredentialsSentMap(map);
  };

  const renderCredentialsStatus = (
    email: string | undefined,
    paymentStatus: Site["paymentStatus"]
  ) => {
    if (!email) return null;

    const isSent = credentialsSentMap.get(email) === true;
    const isFreePlan = paymentStatus === "none";
    const isPaidPlan =
      paymentStatus === "active" || paymentStatus === "pending_cancel";
    const isCollected = transferLogMap.get(email)?.collected === true;

    // 無料プランなら常に表示、有料プランは集金済みの場合のみ表示
    if (!isFreePlan && !(isPaidPlan && isCollected)) {
      return null;
    }

    return (
      <div className="flex items-center gap-2">
        {isSent && (
          <div className="text-blue-600 font-bold">✉️ ログイン情報送信済み</div>
        )}

        <Button
          className="cursor-pointer"
          size="sm"
          variant="default"
          onClick={() => handleSendCredentials(email)}
        >
          ✉️ ログイン情報送信
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
      if (log.email) {
        map.set(log.email, { collected: log.collected ?? false });
      }
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
      <div className="flex items-center gap-2">
        <div className="text-green-600 font-bold">✅ 集金済み</div>
      </div>
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

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">
      <h1 className="text-2xl font-bold mb-4">サイト一覧</h1>

      <Input
        type="text"
        placeholder="名前・電話・メールで検索"
        className="mb-4"
        value={searchKeyword}
        onChange={(e) => setSearchKeyword(e.target.value)}
      />

      {loading && (
        <div className="flex justify-center items-start min-h-screen pt-32">
          <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
        </div>
      )}

      {filteredSites.map((site) => {
        const isPending =
          site.cancelPending === true ||
          site.paymentStatus === "pending_cancel";
        const isCanceled = site.paymentStatus === "canceled";
        const isPaid = site.paymentStatus === "active";

        return (
          <Card key={site.id} className="p-4 shadow-md space-y-2">
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
                <div className="flex items-center gap-2">
                  {site.isFreePlan && (
                    <span className="flex justify-center items-center px-2 py-0.5 text-xs rounded w-20 h-8 bg-blue-500 text-white ml-2">
                      無料
                    </span>
                  )}
                  <div className="flex justify-center w-full bg-gray-500">
                    <span className="font-bold text-lg">{site.siteName}</span>
                  </div>

                  {isPending && (
                    <span className="flex justify-center items-center px-2 py-0.5 text-xs rounded w-20 h-8 bg-yellow-500 text-white">
                      解約予約
                    </span>
                  )}
                  {isCanceled && (
                    <span className="flex justify-center items-center px-2 py-0.5 text-xs rounded w-20 h-8 bg-gray-500 text-white">
                      解約済み
                    </span>
                  )}
                </div>

                <div>オーナー: {site.ownerName}</div>
                <div>電話番号: {site.ownerPhone}</div>
                <div>住所: {site.ownerAddress}</div>
                <div>メール: {site.ownerEmail}</div>
                {renderTransferStatus(
                  site.ownerEmail,
                  transferLogMap,
                  async (email) => {
                    await updateCollectedStatus(email);
                    setTransferLogMap(
                      (prev) => new Map(prev.set(email, { collected: true }))
                    );
                  }
                )}

                {renderCredentialsStatus(site.ownerEmail, site.paymentStatus)}
              </>
            )}

            {site.homepageUrl && (
              <div>
                <a
                  href={site.homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline"
                >
                  ホームページを開く
                </a>
              </div>
            )}

            {editingId === site.id ? (
              <div className="space-y-2">
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
              <div className="flex gap-2 flex-wrap">
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
