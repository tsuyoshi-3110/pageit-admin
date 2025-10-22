import { Timestamp } from "firebase/firestore";

/* ───────── ヘルパー ───────── */
export function toJSDate(t?: Date | Timestamp): Date | undefined {
  if (!t) return undefined;
  if (t instanceof Timestamp) return t.toDate();
  if (t instanceof Date) return t;
  return undefined;
}
export function daysAgoString(date?: Date): string {
  if (!date) return "-";
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return days <= 0 ? "本日" : `${days}日前`;
}
export function formatYMD(date?: Date): string {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
