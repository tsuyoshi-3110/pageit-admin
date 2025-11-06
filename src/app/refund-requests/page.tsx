// app/refund-requests/page.tsx
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RefundItem = { name: string; qty: number; unitAmount: number };
type RefundRow = {
  id: string;
  siteKey: string;
  orderId: string;
  item: RefundItem;
  customer?: { name?: string; email?: string; phone?: string };
  addressText?: string;
  status?: "pending" | "processed";
  createdAt?: any;
};

function jpy(n: number) {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(n);
}

export default async function Page() {
  const snap = await adminDb
    .collection("transferLogs")
    .where("type", "==", "refund_request")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const rows: RefundRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  async function markProcessed(id: string) {
    "use server";
    await adminDb.doc(`transferLogs/${id}`).set(
      { status: "processed", processedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  return (
    <main className="max-w-6xl mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-semibold mb-4">返金依頼</h1>

      <div className="overflow-x-auto bg-white rounded-lg shadow">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">日時</th>
              <th className="p-3 text-left">サイト</th>
              <th className="p-3 text-left">注文ID</th>
              <th className="p-3 text-left">商品</th>
              <th className="p-3 text-left">顧客</th>
              <th className="p-3 text-left">住所</th>
              <th className="p-3 text-left">状態</th>
              <th className="p-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td className="p-6 text-center text-gray-500" colSpan={8}>返金依頼はありません</td></tr>
            )}
            {rows.map((r) => {
              const dt = r.createdAt?.toDate?.() ?? r.createdAt ? new Date(r.createdAt) : new Date(0);
              const title = `${r.item?.name ?? ""} ×${r.item?.qty ?? 0}（${jpy(r.item?.unitAmount ?? 0)}）`;
              return (
                <tr key={r.id} className="border-t align-top">
                  <td className="p-3 whitespace-nowrap">{dt.toLocaleString("ja-JP")}</td>
                  <td className="p-3">{r.siteKey}</td>
                  <td className="p-3 break-all">{r.orderId}</td>
                  <td className="p-3">{title}</td>
                  <td className="p-3">
                    <div className="font-medium">{r.customer?.name ?? "—"}</div>
                    {r.customer?.email && <div className="break-all">{r.customer.email}</div>}
                    {r.customer?.phone && <div>{r.customer.phone}</div>}
                  </td>
                  <td className="p-3 break-words">{r.addressText ?? "—"}</td>
                  <td className="p-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      r.status === "processed" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                    }`}>
                      {r.status ?? "pending"}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    {r.status !== "processed" && (
                      <form action={async () => { "use server"; await markProcessed(r.id); }}>
                        <button
                          type="submit"
                          className="px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90"
                        >
                          処理済みにする
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
