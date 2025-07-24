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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  const invEmail = useAtomValue(invEmailAtom);
  const invOwnerName = useAtomValue(invOwnerNameAtom);

  const setupPrice = 30000;
  const shootingPrice = 50000;
  const amount =
    (setupSelected ? setupPrice : 0) + (shootingSelected ? shootingPrice : 0);
  const tax = Math.round(amount * 0.1);
  const total = amount + tax;

  useEffect(() => {
    const queryName = invOwnerName;
    const queryEmail = invEmail;

    if (queryName) setName(queryName);
    if (queryEmail) setEmail(queryEmail);
  }, []);

  const handleSend = async () => {
    setSending(true);
    const body = `
${name}様

この度はPageitにお申し込みいただき、誠にありがとうございます。

以下の内容で初回セットアップ費用のご案内を申し上げます。

【ご請求金額】
${setupSelected ? `初期セットアップ：${setupPrice.toLocaleString()}円\n` : ""}
${shootingSelected ? `撮影編集代行：${shootingPrice.toLocaleString()}円\n` : ""}
消費税　：${tax.toLocaleString()}円
税込合計：${total.toLocaleString()}円

【振込先情報】
銀行名：三菱東京UFJ銀行
支店名：新大阪支店
口座種別：普通
口座番号：5002177
口座名義：サイトウ　ツヨシ

※振込手数料はご負担ください。

ご入金確認後、セットアップ作業を開始し、1〜3営業日以内にご連絡差し上げます。

---
ご不明な点などございましたら、お気軽にご返信ください。
`;

    try {
      // 1. メール送信
      await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: email,
          subject: "【Pageit】振込のご案内",
          body,
          name,
          setupSelected,
          shootingSelected,
        }),
      });

      // 2. Firestoreに送信履歴を追加
      await addDoc(collection(db, "transferLogs"), {
        name,
        email,
        setupSelected,
        shootingSelected,
        setupPrice: setupSelected ? setupPrice : 0,
        shootingPrice: shootingSelected ? shootingPrice : 0,
        tax,
        total,
        timestamp: new Date(),
      });

      // 3. 完了メッセージ
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

      <div className="space-x-2">
        <Button
          variant={setupSelected ? "default" : "outline"}
          onClick={() => setSetupSelected((prev) => !prev)}
        >
          初期セットアップ（30,000円）
        </Button>
        <Button
          variant={shootingSelected ? "default" : "outline"}
          onClick={() => setShootingSelected((prev) => !prev)}
        >
          撮影編集代行（50,000円）
        </Button>
      </div>

      <div className="text-sm text-gray-700 space-y-1">
        <p>税抜価格：{amount.toLocaleString()}円</p>
        <p>消費税　：{tax.toLocaleString()}円</p>
        <p className="font-semibold">税込合計：{total.toLocaleString()}円</p>
      </div>

      <Button onClick={handleSend} disabled={sending || sent || amount === 0}>
        {sending ? "送信中..." : sent ? "送信済み" : "振込案内を送信"}
      </Button>

      {message && <p>{message}</p>}
    </div>
  );
}
