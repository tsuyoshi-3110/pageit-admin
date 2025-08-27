"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addDoc, collection } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAtomValue } from "jotai";
import { invEmailAtom, invOwnerNameAtom } from "@/lib/atoms/openFlagAtom";

export default function SendTransferPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [setupSelected, setSetupSelected] = useState(false);
  const [shootingSelected, setShootingSelected] = useState(false);
  const [satueiSelected, setSatueiSelected] = useState(false);
  const [henshuSelected, setHenshuSelected] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  const invEmail = useAtomValue(invEmailAtom);
  const invOwnerName = useAtomValue(invOwnerNameAtom);

  const setupPrice = 30000;
  const shootingPrice = 50000;
  const satueiPrice = 40000;
  const henshuPrice = 10000;
  const amount =
    (setupSelected ? setupPrice : 0) +
    (shootingSelected ? shootingPrice : 0) +
    (satueiSelected ? satueiPrice : 0) +
    (henshuSelected ? henshuPrice : 0);
  const tax = Math.round(amount * 0.1);
  const total = amount + tax;

  useEffect(() => {
    const queryName = invOwnerName;
    const queryEmail = invEmail;

    if (queryName) setName(queryName);
    if (queryEmail) setEmail(queryEmail);
  }, []);

  const joinTight = (lines: (string | false | null | undefined)[]) =>
    lines
      .filter((l) => l !== false && l !== null && l !== undefined)
      .reduce<string[]>((acc, raw) => {
        const line = String(raw);
        // 連続する空行は 1 行に圧縮
        if (line.trim() === "" && acc[acc.length - 1]?.trim() === "")
          return acc;
        acc.push(line);
        return acc;
      }, [])
      .join("\n");

  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  // handleSend を置き換え
  const handleSend = async () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const anySelected =
      setupSelected || shootingSelected || satueiSelected || henshuSelected;

    // 必須チェック（name / email / いずれかの項目）
    if (!trimmedName || !trimmedEmail || !anySelected) {
      const missing: string[] = [];
      if (!trimmedName) missing.push("お名前");
      if (!trimmedEmail) missing.push("メールアドレス");
      if (!anySelected) missing.push("選択項目");
      alert(`${missing.join("・")}が未入力です。ご入力・ご選択ください。`);
      return;
    }

    // メール形式チェック（任意）
    if (!isValidEmail(trimmedEmail)) {
      alert("メールアドレスの形式が正しくありません。");
      return;
    }

    setSending(true);

    const body = joinTight([
      `${trimmedName}様`,
      "",
      "この度はPageitにお申し込みいただき、誠にありがとうございます。",
      "",
      "以下の内容で初回セットアップ費用のご案内を申し上げます。",
      "",
      "【ご請求金額】",
      setupSelected && `初期セットアップ：${setupPrice.toLocaleString()}円`,
      shootingSelected &&
        `撮影編集代行　　：${shootingPrice.toLocaleString()}円`,
      satueiSelected && `撮影代行　　　　：${satueiPrice.toLocaleString()}円`,
      henshuSelected && `編集代行　　　　：${henshuPrice.toLocaleString()}円`,
      `消費税　　　　：${tax.toLocaleString()}円`,
      `税込合計　　　：${total.toLocaleString()}円`,
      "",
      "【振込先情報】",
      "銀行名：三菱東京UFJ銀行",
      "支店名：新大阪支店",
      "口座種別：普通",
      "口座番号：5002177",
      "口座名義：サイトウ　ツヨシ",
      "",
      "---",
      "ご不明な点などございましたら、お気軽にご返信ください。",
      "【Xenovant 運営】",
      "メール：pageitstore@gmail.com",
    ]);

    try {
      await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: trimmedEmail,
          subject: "【Pageit】振込のご案内",
          body,
          name: trimmedName,
          setupSelected,
          shootingSelected,
          satueiSelected,
          henshuSelected,
        }),
      });

      await addDoc(collection(db, "transferLogs"), {
        name: trimmedName,
        email: trimmedEmail,
        setupSelected,
        shootingSelected,
        setupPrice: setupSelected ? setupPrice : 0,
        shootingPrice: shootingSelected ? shootingPrice : 0,
        satueiPrice: satueiSelected ? satueiPrice : 0,
        henshuPrice: henshuSelected ? henshuPrice : 0,
        tax,
        total,
        timestamp: new Date(),
      });

      setMessage("送信しました。");
      setSent(true);
    } catch {
      setMessage("送信に失敗しました。もう一度お試しください。");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold">振込案内の送信</h1>
      <Input
        placeholder="お客様の名前"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        placeholder="メールアドレス"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {/* 縦並び・青ベース・タップで濃く・選択中は常時濃い */}
      <div className="flex flex-col gap-2">
        {/* 共通クラス */}
        {/* 選択中: on / 未選択: off を切り替え */}
        {(() => {
          const base =
            "w-full text-black justify-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-400";
          const off = "bg-blue-300 hover:bg-blue-500 active:bg-blue-800";
          const on = "bg-blue-700 hover:bg-blue-800 active:bg-blue-900";

          return (
            <>
              <Button
                className={`${base} ${setupSelected ? on : off}`}
                onClick={() => setSetupSelected((prev) => !prev)}
              >
                初期セットアップ（30,000円）
              </Button>

              <Button
                className={`${base} ${shootingSelected ? on : off}`}
                onClick={() => setShootingSelected((prev) => !prev)}
              >
                撮影編集代行（50,000円）
              </Button>

              <Button
                className={`${base} ${satueiSelected ? on : off}`}
                onClick={() => setSatueiSelected((prev) => !prev)}
              >
                撮影代行（40,000円）
              </Button>

              <Button
                className={`${base} ${henshuSelected ? on : off}`}
                onClick={() => setHenshuSelected((prev) => !prev)}
              >
                編集代行（10,000円）
              </Button>
            </>
          );
        })()}
      </div>

      <div className="text-sm text-gray-700 space-y-1">
        <p>税抜価格：{amount.toLocaleString()}円</p>
        <p>消費税　：{tax.toLocaleString()}円</p>
        <p className="font-semibold">税込合計：{total.toLocaleString()}円</p>
      </div>

      <Button onClick={handleSend} disabled={sending || sent}>
        {sending ? "送信中..." : sent ? "送信済み" : "振込案内を送信"}
      </Button>

      {message && <p>{message}</p>}
    </div>
  );
}
