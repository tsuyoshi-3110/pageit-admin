// components/CardSpinner.tsx
"use client";

export default function CardSpinner() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/10">
      <svg
        className="w-8 h-8 animate-spin text-pink-600"
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        />
      </svg>
    </div>
  );
}
