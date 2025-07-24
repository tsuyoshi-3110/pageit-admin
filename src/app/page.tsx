"use client";

import Image from "next/image";
import { useAtom } from "jotai";
import { openFlagAtom } from "@/lib/atoms/openFlagAtom";
import { useState, useEffect } from "react";

const correctPassword = process.env.NEXT_PUBLIC_PAGEIT_PASSWORD;

export default function Home() {
  const [password, setPassword] = useState("");
  const [openFlag, setOpenFlag] = useAtom(openFlagAtom);

  // ✅ 初回マウント時に localStorage から復元
  useEffect(() => {
    const savedPassword = localStorage.getItem("pageit_password");
    if (savedPassword) {
      setPassword(savedPassword);
      const isValid = savedPassword === correctPassword;
      setOpenFlag(isValid);
    }
  }, [setOpenFlag]);

  // ✅ パスワード変更時にチェック＋保存
  useEffect(() => {
    const isValid = password === correctPassword;
    setOpenFlag(isValid);
    localStorage.setItem("pageit_password", password);
  }, [password, setOpenFlag]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] gap-6 p-8">
      <Image
        src="/images/logo.png"
        alt="Pageit Logo"
        width={450}
        height={450}
        className="mb-4"
      />

      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="パスワードを入力"
        className="border px-4 py-2 rounded w-64 text-center"
      />

      {openFlag && (
        <div className="text-green-600 font-semibold">
          パスワードが一致しました ✅
        </div>
      )}
    </div>
  );
}
