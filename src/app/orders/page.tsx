"use client";

import { useEffect, useState } from "react";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

type FirestoreAny = Record<string, any>;

type Order = {
  id: string;
  siteKey: string;
  status: string;               // "paid" など
  amount: number;               // amountTotal 優先
  createdAtMs: number;          // ms
  lineItems?: { name?: string; qty?: number; unit?: number; subtotal?: number }[];
};

type MonthAgg = {
  totalAmount: number;
  payoutAmount: number;
  count: number;
};

type MonthBucket = {
  agg: MonthAgg;
  orders: Order[];
};

type SiteView = {
  siteKey: string;
  siteName: string;
  thisMonth: MonthBucket;
  lastMonth: MonthBucket;
};

/* ===== 手数料（概算） =====
   運営取り分 5% + Stripe 概算 3.6% + 環境コミット 1% */
const COMMISSION = 0.05;
const STRIPE_FEE = 0.036;
const COMMIT_FEE = 0.01;

const jp = new Intl.NumberFormat("ja-JP");

// Firestore Timestamp/number/Date → ms に正規化
function toMs(v: any): number {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if ((v as Timestamp)?.seconds) return (v as Timestamp).seconds * 1000;
  // 文字列(ISO)などが来たら Date に通す
  const t = new Date(v as any).getTime();
  return Number.isFinite(t) ? t : 0;
}

// JST の月範囲 [startMs, endMs)
function monthRangeJST(y: number, m0: number) {
  // m0: 0=1月
  const startLocal = new Date(y, m0, 1, 0, 0, 0, 0);
  const endLocal = m0 === 11 ? new Date(y + 1, 0, 1, 0, 0, 0, 0) : new Date(y, m0 + 1, 1, 0, 0, 0, 0);
  // Local→UTCms にするため timezone offset を引く
  const startMs = startLocal.getTime() - startLocal.getTimezoneOffset() * 60_000;
  const endMs   = endLocal.getTime()   - endLocal.getTimezoneOffset()   * 60_000;
  return { startMs, endMs };
}

function calcPayout(total: number) {
  const feeRate = COMMISSION + STRIPE_FEE + COMMIT_FEE;
  return Math.floor(total * (1 - feeRate));
}

export default function SalesMonthlyPage() {
  const [sites, setSites] = useState<SiteView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // ===== 1) 注文全件取得（必要なら後で期間クエリに切替）=====
        const ordersSnap = await getDocs(collection(db, "orders"));
        const orders: Order[] = ordersSnap.docs.map((d) => {
          const data = d.data() as FirestoreAny;
          return {
            id: d.id,
            siteKey: String(data.siteKey || ""),
            status: String(data.status || ""),
            amount: Number(
              data.amountTotal ?? data.amount ?? 0
            ),
            createdAtMs: toMs(data.createdAt),
            lineItems: Array.isArray(data.lineItems) ? data.lineItems : undefined,
          };
        });

        // paid のみ対象
        const paid = orders.filter((o) => o.status === "paid" && o.siteKey);

        // ===== 2) 月範囲（今月/先月）=====
        const now = new Date();
        const y = now.getFullYear();
        const m0 = now.getMonth();
        const { startMs: thisStart, endMs: thisEnd } = monthRangeJST(y, m0);

        const lastY  = m0 === 0 ? y - 1 : y;
        const lastM0 = m0 === 0 ? 11 : m0 - 1;
        const { startMs: lastStart, endMs: lastEnd } = monthRangeJST(lastY, lastM0);

        // ===== 3) サイト別バケット作成 =====
        const map = new Map<
          string,
          { thisMonth: MonthBucket; lastMonth: MonthBucket }
        >();

        const ensure = (key: string) => {
          if (!map.has(key)) {
            map.set(key, {
              thisMonth: { agg: { totalAmount: 0, payoutAmount: 0, count: 0 }, orders: [] },
              lastMonth: { agg: { totalAmount: 0, payoutAmount: 0, count: 0 }, orders: [] },
            });
          }
          return map.get(key)!;
        };

        const addAgg = (bucket: MonthBucket, amount: number, order: Order) => {
          const a = bucket.agg;
          a.totalAmount += Number.isFinite(amount) ? amount : 0;
          a.count += 1;
          a.payoutAmount = calcPayout(a.totalAmount);
          bucket.orders.push(order);
        };

        for (const o of paid) {
          const group = ensure(o.siteKey);
          if (o.createdAtMs >= thisStart && o.createdAtMs < thisEnd) {
            addAgg(group.thisMonth, o.amount, o);
          } else if (o.createdAtMs >= lastStart && o.createdAtMs < lastEnd) {
            addAgg(group.lastMonth, o.amount, o);
          }
        }

        // この時点で販売のある siteKey 一覧
        const siteKeys = Array.from(map.keys());

        // ===== 4) siteName を siteSettings から取得 =====
        const nameMap = new Map<string, string>();
        await Promise.all(
          siteKeys.map(async (key) => {
            const s = await getDoc(doc(db, "siteSettings", key));
            nameMap.set(key, (s.exists() && (s.data() as FirestoreAny).siteName) || key);
          })
        );

        // ===== 5) 表示行へ変換・並べ替え =====
        const rows: SiteView[] = siteKeys.map((key) => {
          const buckets = map.get(key)!;
          return {
            siteKey: key,
            siteName: nameMap.get(key) || key,
            thisMonth: buckets.thisMonth,
            lastMonth: buckets.lastMonth,
          };
        }).sort((a, b) => b.thisMonth.agg.totalAmount - a.thisMonth.agg.totalAmount);

        setSites(rows);
      } catch (e) {
        console.error("月次集計エラー:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="p-6">集計中…</div>;

  const ym = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">月次販売サマリー ＋ 販売リスト</h1>
      <p className="text-sm text-gray-500">
        表示は JST の {ym(now)}（今月）と {ym(prev)}（先月）。履歴は削除せず期間で集計しています。
      </p>

      {!sites.length && (
        <p className="text-gray-500">対象期間の注文がありません。</p>
      )}

      {sites.map((s) => (
        <div key={s.siteKey} className="bg-white border rounded-xl shadow p-5 space-y-5">
          {/* ヘッダ */}
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold">{s.siteName}</h2>
            <span className="text-xs text-gray-500">siteKey: {s.siteKey}</span>
          </div>

          {/* サマリー */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryCard title={ym(now)} agg={s.thisMonth.agg} />
            <SummaryCard title={ym(prev)} agg={s.lastMonth.agg} />
          </div>

          {/* 今月の販売リスト */}
          <OrdersTable title={`${ym(now)}の販売リスト`} orders={s.thisMonth.orders} />

          {/* 先月の販売リスト */}
          <OrdersTable title={`${ym(prev)}の販売リスト`} orders={s.lastMonth.orders} />
        </div>
      ))}
    </div>
  );
}

/* ===== Presentational Components ===== */

function SummaryCard({ title, agg }: { title: string; agg: MonthAgg }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-gray-500 mb-2">{title}</div>
      <div className="mb-1">
        売上合計: <strong>¥{jp.format(agg.totalAmount)}</strong>{" "}
        <span className="text-xs text-gray-500">（{agg.count}件）</span>
      </div>
      <div className="font-semibold text-green-700">
        振込額（控除後）: ¥{jp.format(agg.payoutAmount)}
      </div>
      <div className="text-xs text-gray-500 mt-1">
        ※ 控除率: 運営5% + Stripe概算3.6% + 環境1%
      </div>
    </div>
  );
}

function OrdersTable({ title, orders }: { title: string; orders: Order[] }) {
  if (!orders.length) {
    return (
      <div>
        <h3 className="text-lg font-bold mb-2">{title}</h3>
        <p className="text-sm text-gray-500">注文はありません。</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <h3 className="text-lg font-bold mb-2">{title}</h3>
      <table className="w-full text-sm border">
        <thead className="bg-gray-50">
          <tr>
            <th className="border px-2 py-1 text-left">日時</th>
            <th className="border px-2 py-1 text-left">商品</th>
            <th className="border px-2 py-1 text-right">金額</th>
            <th className="border px-2 py-1 text-left">ステータス</th>
            <th className="border px-2 py-1 text-left">明細</th>
          </tr>
        </thead>
        <tbody>
          {orders
            .slice()
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
            .map((o) => (
              <tr key={o.id}>
                <td className="border px-2 py-1">
                  {new Date(o.createdAtMs).toLocaleString("ja-JP")}
                </td>
                <td className="border px-2 py-1">
                  {o.lineItems?.[0]?.name || "（商品名未登録）"}
                </td>
                <td className="border px-2 py-1 text-right">¥{jp.format(o.amount)}</td>
                <td className="border px-2 py-1">{o.status}</td>
                <td className="border px-2 py-1">
                  {/* lineItems の簡易表示 */}
                  {o.lineItems && o.lineItems.length ? (
                    <details>
                      <summary className="cursor-pointer select-none text-blue-600">表示</summary>
                      <ul className="list-disc ml-5 my-1">
                        {o.lineItems.map((li, i) => (
                          <li key={i}>
                            {li.name ?? "item"} ×{li.qty ?? 1}（単価 ¥{jp.format(li.unit ?? 0)} / 小計 ¥{jp.format(li.subtotal ?? 0)}）
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
