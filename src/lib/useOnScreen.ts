// hooks/useOnScreen.ts
import { useEffect, useRef, useState, RefObject } from "react";

export function useOnScreen<T extends HTMLElement = HTMLElement>(
  rootMargin = "0px"
): [RefObject<T>, boolean] {
  /** ❶ `T | null` で保持 */
  const ref = useRef<T | null>(null);
  const [isIntersecting, setIntersecting] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIntersecting(entry.isIntersecting),
      { rootMargin }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [rootMargin]);

  /** ❷ 戻り値を `as RefObject<T>` にキャストして型を一致させる */
  return [ref as unknown as RefObject<T>, isIntersecting];
}
