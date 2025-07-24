// src/components/ThemeProvider.tsx
"use client";

import { ReactNode, useEffect } from "react";
import { useAtom } from "jotai";
import { themeAtom } from "@/lib/atoms/openFlagAtom";

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useAtom(themeAtom);

  // 初回マウントで localStorage から状態を復元
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "dark") {
      setTheme("dark");
      document.documentElement.classList.add("dark");
    } else {
      setTheme("light");
      document.documentElement.classList.remove("dark");
    }
  }, [setTheme]);

  // 状態変更時に class と localStorage を同期
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [theme]);

  return <>{children}</>;
}
