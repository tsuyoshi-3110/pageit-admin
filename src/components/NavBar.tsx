"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { User } from "firebase/auth";
import { useAtom } from "jotai";
import { openFlagAtom } from "@/lib/atoms/openFlagAtom";
import { Menu, X } from "lucide-react";

export default function NavBar() {
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFlag, setOpenFlag] = useAtom(openFlagAtom);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    return () => unsub();
  }, []);

  useEffect(() => {
    const savedFlag = localStorage.getItem("pageit_open_flag");
    if (savedFlag !== null) {
      setOpenFlag(JSON.parse(savedFlag));
    }
  }, [setOpenFlag]);

  const toggleMenu = () => setMenuOpen((prev) => !prev);

  return (
    <>
      {/* ナビバー */}
      <nav className="fixed top-0 left-0 w-full h-16 bg-white shadow-md px-4 md:px-6 py-4 flex items-center justify-between z-50">
        <Link
          href="/"
          className="text-lg font-bold text-gray-700 hover:text-blue-500"
        >
          Pageit管理サイト
        </Link>

        {/* ハンバーガーアイコン（モバイル） */}
        <button
          className=" text-gray-700"
          onClick={toggleMenu}
          aria-label="メニューを開く"
        >
          <Menu className="w-6 h-6" />
        </button>
      </nav>

      {/* オーバーレイ */}
      {menuOpen && (
        <div
          className="fixed inset-0 right-64 z-[55] bg-white/30 backdrop-blur-sm backdrop-saturate-150 transition-opacity"
          onClick={toggleMenu}
          aria-hidden
        />
      )}

      {/* ドロワーメニュー */}
      <div
        className={`fixed top-0 right-0 h-full w-64 bg-white shadow-lg z-50 transform transition-transform duration-300 ease-in-out ${
          menuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex justify-between items-center px-4 py-4 border-b">
          <span className="text-lg font-bold">メニュー</span>
          <button onClick={toggleMenu}>
            <X className="w-6 h-6 text-gray-700" />
          </button>
        </div>

        <div className="flex flex-col px-4 py-2 space-y-3">
          {openFlag && (
            <>

              {user && (
                <>
                  <Link
                    href="/register"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    アカウント作成
                  </Link>
                  <Link
                    href="/sites"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    サイト一覧
                  </Link>
                  <Link
                    href="/send-transfer"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    請求メール
                  </Link>
                  <Link
                    href="/transfer-logs"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    請求メール送信一覧
                  </Link>
                  <Link
                    href="/send-credentials"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    アカウントメール
                  </Link>
                  <Link
                    href="/postList"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    タイムライン
                  </Link>
                  <Link
                    href="/community"
                    onClick={toggleMenu}
                    className="text-gray-700 hover:text-blue-500"
                  >
                    コミュニティ
                  </Link>
                </>
              )}

               <Link
                href="/login"
                onClick={toggleMenu}
                className="text-gray-700 hover:text-blue-500"
              >
                ログイン
              </Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}
