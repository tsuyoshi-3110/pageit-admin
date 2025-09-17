/* --------------------------------------------------------------------------
 * components/ProductMedia.tsx
 *  - 画像／動画を 1:1 で表示（縦長写真は上下に余白が入る object-contain）
 *  - 動画は IntersectionObserver で可視領域のみ再生
 * ------------------------------------------------------------------------ */
"use client";

import Image, { StaticImageData } from "next/image";
import clsx from "clsx";
import { useState } from "react";
import CardSpinner from "./CardSpinner";
import { useOnScreen } from "@/lib/useOnScreen";

type Src = string | StaticImageData;
interface Props {
  src: Src;
  type: "image" | "video";
  /** tailwind など追加クラス */
  className?: string;
  /** video 用オプション（省略なら true） */
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  /** image 用 alt */
  alt?: string;
}

export default function ProductMedia({
  src,
  type,
  className = "",
  autoPlay = true,
  loop = true,
  muted = true,
  alt = "",
}: Props) {
  /* ---- 共通 ---- */
  const [loaded, setLoaded] = useState(false);
  /* 画面内判定（動画の省エネ再生制御） */
  const [ref, visible] = useOnScreen<HTMLDivElement>("120px");

  /* =======================================================
     VIDEO  (正方形 & 遅延再生)
  ======================================================= */
  if (type === "video") {
    return (
      <div
        ref={ref}
        className={clsx(
          "relative w-full aspect-square overflow-hidden", // ★ 常に 1:1
          className
        )}
      >
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10">
            <CardSpinner />
          </div>
        )}

        <video
          src={visible && typeof src === "string" ? src : undefined}
          className={clsx(
            "absolute inset-0 w-full h-full object-cover",
            loaded ? "visible" : "invisible"
          )}
          onLoadedMetadata={() => setLoaded(true)} // ← 追加：メタデータ読めた時点で閉じる
          onLoadedData={() => setLoaded(true)}
          onError={() => setLoaded(true)} // ← 追加：失敗でも閉じる（必要ならプレースホルダに差し替えも可）
          playsInline
          muted={muted}
          autoPlay={visible && autoPlay}
          loop={visible && loop}
          preload="metadata"
        />
      </div>
    );
  }

  /* =======================================================
     IMAGE  (正方形・縦横に応じて cover / contain)
  ======================================================= */

  return (
    <div
      ref={ref}
      className={clsx(
        "relative w-full aspect-square overflow-hidden",
        className
      )}
    >
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10">
          <CardSpinner />
        </div>
      )}

      <Image
        src={src}
        alt={alt}
        fill
        className={clsx(
          "object-cover transition-opacity duration-500",
          loaded ? "opacity-100" : "opacity-0"
        )}
        sizes="(min-width:1024px) 320px, (min-width:640px) 45vw, 90vw"
        onLoadingComplete={() => setLoaded(true)}
        onError={() => setLoaded(true)} // ← 追加：失敗でもスピナーを閉じる
        priority={false}
        unoptimized
      />
    </div>
  );
}
