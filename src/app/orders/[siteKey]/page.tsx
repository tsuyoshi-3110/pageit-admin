// app/orders/[siteKey]/page.tsx
"use client";

import React, { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy as fbOrderBy,
  limit as fbLimit,
} from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2 } from "lucide-react";

type OrderDoc = {
  id: string;
  siteKey: string;
  amount: number;               // JPY（整数）
  currency?: string;            // "jpy" など
  paymentIntentId?: string;     // 返金に必須
  status?: "completed" | "refunded" | string;
  refunded?: boolean;
  refundId?: string | null;
  refundAt?: Date | null;
  customer?: { name?: string; email?: string };
  createdAt?: any;              // Timestamp | Date
  // 商品情報（存在すれば表示）
  items?: Array<{ name?: string; qty?: number; unitAmount?: number }>;
};

function jpy(n?: number) {
  return typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "-";
}

export default function OrdersPage({
  params,
}: {
  params: Promise<{ siteKey: string }>;
}) {
  const router = useRouter();
  // Next.js 15: params は Promise。React.use でアンラップ
  const { siteKey } = use(params);

  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderDoc[]>([]);
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundAmountMap, setRefundAmountMap] = useState<Record<string, number>>({});
  // 注文IDフィルター（部分一致）
  const [orderIdFilter, setOrderIdFilter] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }
      setLoading(true);
      try {
        const q_ = query(
          collection(db, "siteOrders"),
          where("siteKey", "==", siteKey),
          fbOrderBy("createdAt", "desc"),
          fbLimit(200)
        );
        const snap = await getDocs(q_);
        const list: OrderDoc[] = snap.docs.map((d) => {
          const x: any = d.data();
          return {
            id: d.id,
            ...x,
            refundAt: x?.refundAt?.toDate ? x.refundAt.toDate() : null,
            createdAt: x?.createdAt?.toDate ? x.createdAt.toDate() : null,
          };
        });
        setOrders(list);

        // 既定の返金額=全額
        const defaults: Record<string, number> = {};
        list.forEach((o) => {
          if (!o.refunded) defaults[o.id] = Number(o.amount || 0);
        });
        setRefundAmountMap(defaults);
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, [router, siteKey]);

  // フィルタ後の表示（クライアント側）
  const filteredOrders = useMemo(() => {
    const key = orderIdFilter.trim().toLowerCase();
    if (!key) return orders;
    return orders.filter((o) => o.id.toLowerCase().includes(key));
  }, [orders, orderIdFilter]);

  async function handleRefund(order: OrderDoc) {
    if (!order.paymentIntentId) {
      alert("この注文には paymentIntentId がありません。返金できません。");
      return;
    }
    const full = Number(order.amount || 0);
    const reqAmount = Number(refundAmountMap[order.id] ?? full);
    if (!Number.isInteger(reqAmount) || reqAmount <= 0 || reqAmount > full) {
      alert("返金額が不正です。0より大きく、注文金額以下の整数（円）で指定してください。");
      return;
    }
    if (!confirm(`返金しますか？\n注文ID: ${order.id}\n返金額: ${jpy(reqAmount)}`)) {
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          orderId: order.id,
          siteKey: order.siteKey,
          paymentIntentId: order.paymentIntentId,
          amount: reqAmount, // 未指定ならサーバーで全額
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      // UI 同期
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

  const title = useMemo(() => `購入履歴（${siteKey}）`, [siteKey]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold">{title}</h1>
        <div className="flex gap-2">
          {/* 注文IDフィルター */}
          <Input
            placeholder="注文IDで絞り込み"
            className="w-48"
            value={orderIdFilter}
            onChange={(e) => setOrderIdFilter(e.target.value)}
          />
          {orderIdFilter && (
            <Button variant="ghost" onClick={() => setOrderIdFilter("")}>
              クリア
            </Button>
          )}
          <Button variant="outline" onClick={() => router.back()}>
            戻る
          </Button>
        </div>
      </div>

      <Card className="p-4">
        {loading ? (
          <div className="flex justify-center items-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-600">購入履歴はありません。</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>購入者</TableHead>
                  <TableHead>注文ID</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>PI</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead className="text-right">返金</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((o) => {
                  const created =
                    o.createdAt instanceof Date
                      ? o.createdAt
                      : o.createdAt?.toDate?.() ?? null;
                  const canRefund = !!o.paymentIntentId && !o.refunded;
                  // 商品名（name × qty をカンマ区切り）
                  const itemLabel =
                    o.items?.length
                      ? o.items
                          .map((i) => {
                            const n = i?.name?.trim();
                            if (!n) return "";
                            const q = typeof i?.qty === "number" && i.qty > 0 ? `×${i.qty}` : "";
                            return `${n}${q}`;
                          })
                          .filter(Boolean)
                          .join(", ")
                      : "-";
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="whitespace-nowrap">
                        {created ? created.toLocaleString("ja-JP") : "-"}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {o.customer?.name || o.customer?.email || "-"}
                      </TableCell>
                      <TableCell
                        className="max-w-[240px] truncate font-mono text-[11px]"
                        title={o.id}
                      >
                        {o.id}
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate" title={itemLabel}>
                        {itemLabel}
                      </TableCell>
                      <TableCell className="text-right">
                        {jpy(o.amount)}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate" title={o.paymentIntentId}>
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
        )}
      </Card>
    </div>
  );
}
