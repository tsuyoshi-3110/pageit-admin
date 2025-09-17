"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  collection,
  getDocs,
  limit as qLimit,
  orderBy,
  query,
  startAfter,
  QueryDocumentSnapshot,
  DocumentData,
  Timestamp,
  doc,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Loader2, RefreshCcw, Search, Archive, Undo2, Trash2, X } from "lucide-react";

type TransferLog = {
  id: string;
  name: string;
  email: string;
  setupSelected?: boolean;
  setupPrice?: number;
  shootingSelected?: boolean;
  shootingPrice?: number;
  satueiSelected?: boolean;
  satueiPrice?: number;
  henshuSelected?: boolean;
  henshuPrice?: number;
  fullSelected?: boolean;
  fullPrice?: number;
  tax?: number;
  total?: number;
  collected?: boolean;
  archived?: boolean;
  timestamp?: Timestamp | { toDate: () => Date } | null;
};

const fmtJPY = (n: number | undefined | null) => (Number(n) || 0).toLocaleString("ja-JP");
const toDateSafe = (ts: TransferLog["timestamp"]) => {
  if (!ts) return null;
  if (typeof (ts as any).toDate === "function") return (ts as any).toDate();
  return null;
};

const PAGE_SIZE = 20;
const MULTI_FETCH_LIMIT = 5;
const DOUBLE_TAP_MS = 300;

export default function TransferLogsPage() {
  const [rows, setRows] = useState<TransferLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);

  // 表示モード：false=通常一覧 / true=アーカイブ一覧
  const [showArchived, setShowArchived] = useState(false);

  // 各モード用のカーソル＆hasMore
  const lastSnapActiveRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const lastSnapArchivedRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMoreActive, setHasMoreActive] = useState(true);
  const [hasMoreArchived, setHasMoreArchived] = useState(true);

  // 検索・入金未
  const [qText, setQText] = useState("");
  const [onlyUncollected, setOnlyUncollected] = useState(false);

  // 行単位 busy
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const setBusyFor = useCallback((id: string, v: boolean) => {
    setBusy((prev) => ({ ...prev, [id]: v }));
  }, []);

  // モーダル
  const [modalOpen, setModalOpen] = useState(false);
  const [modalRow, setModalRow] = useState<TransferLog | null>(null);

    const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalRow(null);
  }, []);

  // ダブルタップ検出
  const lastTapTimeRef = useRef<Record<string, number>>({});

  // サーバーからページを1枚取得
  const fetchPage = useCallback(
    async (after: QueryDocumentSnapshot<DocumentData> | null) => {
      const base = collection(db, "transferLogs");
      const qy = after
        ? query(base, orderBy("timestamp", "desc"), startAfter(after), qLimit(PAGE_SIZE))
        : query(base, orderBy("timestamp", "desc"), qLimit(PAGE_SIZE));
      const snap = await getDocs(qy);
      return snap;
    },
    []
  );

  // 先頭読み込み（モード別にアーカイブを除外/抽出して蓄積）
  const fetchHead = useCallback(async () => {
    setLoading(true);
    try {
      if (showArchived) {
        lastSnapArchivedRef.current = null;
        setHasMoreArchived(true);
      } else {
        lastSnapActiveRef.current = null;
        setHasMoreActive(true);
      }

      const visible: TransferLog[] = [];
      let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
      let hasMoreLocal = true;

      for (let i = 0; i < MULTI_FETCH_LIMIT && visible.length < PAGE_SIZE && hasMoreLocal; i++) {
        const snap = await fetchPage(cursor);
        const pageAll = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as TransferLog[];
        const pageVisible = pageAll.filter((r) => (showArchived ? r.archived === true : r.archived !== true));
        visible.push(...pageVisible);
        cursor = snap.docs.at(-1) ?? null;
        hasMoreLocal = snap.size === PAGE_SIZE;
        if (!hasMoreLocal) break;
      }

      setRows(visible.slice(0, PAGE_SIZE));
      closeModal();

      if (showArchived) {
        lastSnapArchivedRef.current = cursor;
        setHasMoreArchived(!!cursor);
      } else {
        lastSnapActiveRef.current = cursor;
        setHasMoreActive(!!cursor);
      }
    } catch (e) {
      console.error(e);
      alert("読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [fetchPage, showArchived, closeModal]);

  // 追加読み込み（モード別）
  const fetchMore = useCallback(async () => {
    const hasMore = showArchived ? hasMoreArchived : hasMoreActive;
    const cursorRef = showArchived ? lastSnapArchivedRef : lastSnapActiveRef;
    if (!hasMore || moreLoading) return;

    setMoreLoading(true);
    try {
      const acc: TransferLog[] = [];
      let cursor = cursorRef.current;
      let hasMoreLocal = true;

      for (let i = 0; i < MULTI_FETCH_LIMIT && acc.length < PAGE_SIZE && hasMoreLocal; i++) {
        const snap = await fetchPage(cursor);
        const pageAll = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as TransferLog[];
        const pageVisible = pageAll.filter((r) => (showArchived ? r.archived === true : r.archived !== true));
        acc.push(...pageVisible);
        cursor = snap.docs.at(-1) ?? null;
        hasMoreLocal = snap.size === PAGE_SIZE;
        if (!hasMoreLocal) break;
      }

      if (acc.length > 0) setRows((prev) => [...prev, ...acc]);

      if (showArchived) {
        lastSnapArchivedRef.current = cursor;
        setHasMoreArchived(!!cursor);
      } else {
        lastSnapActiveRef.current = cursor;
        setHasMoreActive(!!cursor);
      }
    } catch (e) {
      console.error(e);
      alert("追加読み込みに失敗しました。");
    } finally {
      setMoreLoading(false);
    }
  }, [fetchPage, hasMoreActive, hasMoreArchived, moreLoading, showArchived]);

  // 初回＆モード変更時
  useEffect(() => {
    fetchHead();
  }, [fetchHead]);

  // アーカイブ切替（復元含む）
  const toggleArchive = useCallback(
    async (row: TransferLog) => {
      const id = row.id;
      if (!id) return;
      setBusyFor(id, true);
      try {
        const ref = doc(db, "transferLogs", id);
        const next = !row.archived;
        await updateDoc(ref, { archived: next });

        // 現モードに適合しないなら即リストから除去
        setRows((prev) =>
          prev.filter((r) => {
            if (r.id !== id) return true;
            return showArchived ? next === true : next !== true;
          })
        );
        closeModal();
      } catch (e) {
        console.error(e);
        alert("アーカイブ処理に失敗しました。");
      } finally {
        setBusyFor(id, false);
      }
    },
    [setBusyFor, showArchived, closeModal]
  );

  // 完全削除
  const hardDelete = useCallback(
    async (row: TransferLog) => {
      const id = row.id;
      if (!id) return;
      const ok = window.confirm(`「${row.name ?? row.email ?? id}」の履歴を完全に削除します。よろしいですか？（元に戻せません）`);
      if (!ok) return;

      setBusyFor(id, true);
      try {
        const ref = doc(db, "transferLogs", id);
        await deleteDoc(ref);
        setRows((prev) => prev.filter((r) => r.id !== id));
        closeModal();
      } catch (e) {
        console.error(e);
        alert("削除に失敗しました。");
      } finally {
        setBusyFor(id, false);
      }
    },
    [setBusyFor, closeModal]
  );

  // 検索・入金未の二次フィルタ
  const viewRows = useMemo(() => {
    const text = qText.trim().toLowerCase();
    return rows.filter((r) => {
      const hit = !text || [r.name, r.email].filter(Boolean).join(" ").toLowerCase().includes(text);
      const pass = onlyUncollected ? !r.collected : true;
      return hit && pass;
    });
  }, [rows, qText, onlyUncollected]);

  const totals = useMemo(() => {
    const totalAmount = viewRows.reduce((acc, r) => acc + (Number(r.total) || 0), 0);
    return { totalAmount, count: viewRows.length };
  }, [viewRows]);

  const hasMore = showArchived ? hasMoreArchived : hasMoreActive;

  // 行のダブルクリック/ダブルタップでモーダル
  const makeRowHandlers = useCallback(
    (row: TransferLog) => {
      const id = row.id;

      const open = () => {
        setModalRow(row);
        setModalOpen(true);
      };

      const onDoubleClick: React.MouseEventHandler<HTMLTableRowElement> = (e) => {
        e.stopPropagation();
        open();
      };

      const onTouchEnd: React.TouchEventHandler<HTMLTableRowElement> = (e) => {
        e.stopPropagation();
        const now = Date.now();
        const last = lastTapTimeRef.current[id] || 0;
        lastTapTimeRef.current[id] = now;
        if (now - last < DOUBLE_TAP_MS) open();
      };

      return { onDoubleClick, onTouchEnd };
    },
    []
  );



  // ESCでモーダル閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    if (modalOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen, closeModal]);

  return (
    <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
      {/* ヘッダー */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {showArchived ? "アーカイブ一覧" : "請求書送信履歴"}
        </h1>

        <div className="flex items-center gap-2">
          {/* 表示切替 */}
          <div className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-neutral-700">
            <button
              onClick={() => { closeModal(); setShowArchived(false); fetchHead(); }}
              className={`px-3 py-1.5 text-sm rounded-md ${!showArchived ? "bg-blue-600 text-white" : "text-gray-700 dark:text-gray-200"}`}
              title="通常一覧"
            >
              通常一覧
            </button>
            <button
              onClick={() => { closeModal(); setShowArchived(true); fetchHead(); }}
              className={`px-3 py-1.5 text-sm rounded-md ${showArchived ? "bg-blue-600 text-white" : "text-gray-700 dark:text-gray-200"}`}
              title="アーカイブ一覧"
            >
              アーカイブ一覧
            </button>
          </div>

          <button
            onClick={() => { closeModal(); fetchHead(); }}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:bg-neutral-900 dark:text-gray-100 dark:border-neutral-700"
          >
            <RefreshCcw className="h-4 w-4" />
            再読み込み
          </button>
        </div>
      </div>

      {/* 検索 & フィルタ */}
      <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
            <input
              value={qText}
              onChange={(e) => setQText(e.target.value)}
              placeholder={`${showArchived ? "（アーカイブ）" : ""}名前 / メールで検索`}
              className="w-64 max-w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 py-2 text-sm text-gray-800 shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:bg-neutral-900 dark:text-gray-100 dark:border-neutral-700"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-blue-600"
              checked={onlyUncollected}
              onChange={(e) => setOnlyUncollected(e.target.checked)}
            />
            入金未確認のみ
          </label>
        </div>
      </div>

      {/* テーブル（横はみ出し防止：min-w-full / break-words / containerはoverflow-x-hidden） */}
      <div className="mt-4 overflow-x-hidden rounded-xl border border-gray-200 bg-white shadow dark:bg-neutral-900 dark:border-neutral-800">
        <table className="min-w-full w-full table-auto text-sm">
          <thead className="bg-gray-50 text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">日時</th>
              <th className="px-3 py-2 text-left font-semibold">顧客</th>
              <th className="px-3 py-2 text-left font-semibold">内訳</th>
              <th className="px-3 py-2 text-right font-semibold">税額</th>
              <th className="px-3 py-2 text-right font-semibold">税込合計</th>
              <th className="px-3 py-2 text-center font-semibold">入金</th>
              {/* 操作列は削除しました */}
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-100 dark:divide-neutral-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" />
                </td>
              </tr>
            ) : viewRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  データがありません
                </td>
              </tr>
            ) : (
              viewRows.map((r) => {
                const dt = toDateSafe(r.timestamp)?.toLocaleString("ja-JP") ?? "-";
                const parts: string[] = [];
                if (r.setupSelected) parts.push(`初期設定 ¥${fmtJPY(r.setupPrice)}`);
                if (r.shootingSelected) parts.push(`撮影編集代行 ¥${fmtJPY(r.shootingPrice)}`);
                if (r.satueiSelected) parts.push(`撮影代行 ¥${fmtJPY(r.satueiPrice)}`);
                if (r.henshuSelected) parts.push(`編集代行 ¥${fmtJPY(r.henshuPrice)}`);
                if (r.fullSelected) parts.push(`フルセット ¥${fmtJPY(r.fullPrice)}`);

                const handlers = makeRowHandlers(r);

                return (
                  <tr
                    key={r.id}
                    onDoubleClick={handlers.onDoubleClick}
                    onTouchEnd={handlers.onTouchEnd}
                    className="hover:bg-gray-50/60 dark:hover:bg-neutral-800/40 select-none cursor-pointer"
                    title="ダブルタップ/ダブルクリックで操作"
                  >
                    <td className="px-3 py-2 align-top text-gray-700 dark:text-gray-200 whitespace-normal break-words">
                      {dt}
                    </td>
                    <td className="px-3 py-2 align-top whitespace-normal break-words">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{r.name || "-"}</div>
                      <div className="text-gray-500 dark:text-gray-400 text-xs">{r.email || "-"}</div>
                    </td>
                    <td className="px-3 py-2 align-top text-gray-800 dark:text-gray-100 whitespace-normal break-words">
                      {parts.length ? parts.join(" / ") : "-"}
                    </td>
                    <td className="px-3 py-2 align-top text-right text-gray-700 dark:text-gray-200">
                      ¥{fmtJPY(r.tax)}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-semibold text-gray-900 dark:text-gray-100">
                      ¥{fmtJPY(r.total)}
                    </td>
                    <td className="px-3 py-2 align-top text-center">
                      {r.collected ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          済
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500 dark:bg-neutral-800 dark:text-gray-300">
                          未
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>

          {!loading && viewRows.length > 0 && (
            <tfoot className="bg-gray-50 dark:bg-neutral-800">
              <tr>
                <td colSpan={2} className="px-3 py-2 text-sm text-gray-600 dark:text-gray-300">
                  件数：{totals.count} 件
                </td>
                <td />
                <td />
                <td className="px-3 py-2 text-right font-semibold text-gray-900 dark:text-gray-100">
                  合計：¥{fmtJPY(totals.totalAmount)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* もっと読む（モード別にアーカイブ混入を排除したまま追加） */}
      {hasMore && !loading && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => { closeModal(); fetchMore(); }}
            disabled={moreLoading}
            className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-5 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {moreLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            さらに読み込む
          </button>
        </div>
      )}

      {/* モーダル：行操作 */}
      {modalOpen && modalRow && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          aria-modal="true"
          role="dialog"
          onClick={closeModal}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />

          {/* Dialog */}
          <div
            className="relative z-10 w-full sm:w-[520px] max-w-[92vw] rounded-2xl bg-white p-4 shadow-xl dark:bg-neutral-900 mx-2 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                操作
              </h2>
              <button
                onClick={closeModal}
                className="inline-flex rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-neutral-800"
                aria-label="閉じる"
                title="閉じる"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 対象概要 */}
            <div className="mt-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-neutral-800">
              <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
                {modalRow.name || "-"}
              </div>
              <div className="text-gray-500 dark:text-gray-400 break-words text-xs">
                {modalRow.email || "-"}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="text-gray-600 dark:text-gray-300">日時</div>
                <div className="text-gray-900 dark:text-gray-100 text-right">
                  {toDateSafe(modalRow.timestamp)?.toLocaleString("ja-JP") ?? "-"}
                </div>
                <div className="text-gray-600 dark:text-gray-300">税込合計</div>
                <div className="text-gray-900 dark:text-gray-100 text-right">
                  ¥{fmtJPY(modalRow.total)}
                </div>
              </div>
            </div>

            {/* アクション */}
            <div className="mt-4 flex items-center justify-between gap-2">
              {/* アーカイブ / 戻す */}
              <button
                onClick={() => toggleArchive(modalRow)}
                disabled={!!busy[modalRow.id]}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-white disabled:opacity-50 ${
                  modalRow.archived ? "bg-amber-600 hover:bg-amber-700" : "bg-gray-700 hover:bg-gray-800"
                }`}
                title={modalRow.archived ? "戻す" : "アーカイブ"}
              >
                {busy[modalRow.id] ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : modalRow.archived ? (
                  <Undo2 className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                <span className="text-sm">{modalRow.archived ? "戻す" : "アーカイブ"}</span>
              </button>

              {/* 削除 */}
              <button
                onClick={() => hardDelete(modalRow)}
                disabled={!!busy[modalRow.id]}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-white hover:bg-red-700 disabled:opacity-50"
                title="削除"
              >
                {busy[modalRow.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span className="text-sm">削除</span>
              </button>
            </div>


          </div>
        </div>
      )}
    </main>
  );
}
