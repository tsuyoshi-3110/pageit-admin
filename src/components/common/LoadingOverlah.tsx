"use client";
import { Loader2 } from "lucide-react";

export default function LoadingOverlay({
  open,
  message = "処理中…",
  progress = null, // 0-100 or null
}: {
  open: boolean;
  message?: string;
  progress?: number | null;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={message}
    >
      <div className="w-[min(92vw,360px)] rounded-2xl bg-white p-4 shadow-lg dark:bg-neutral-900">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-gray-700 dark:text-gray-200" />
          <span className="text-sm text-gray-800 dark:text-gray-100">{message}</span>
        </div>
        {typeof progress === "number" && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-neutral-800">
            <div
              className="h-2 bg-blue-600 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
