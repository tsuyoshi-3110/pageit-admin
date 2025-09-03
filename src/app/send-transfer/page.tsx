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

  // 数量
  const [setupQty, setSetupQty] = useState<number>(0);
  const [shootingQty, setShootingQty] = useState<number>(0);
  const [satueiQty, setSatueiQty] = useState<number>(0);
  const [henshuQty, setHenshuQty] = useState<number>(0);

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  const invEmail = useAtomValue(invEmailAtom);
  const invOwnerName = useAtomValue(invOwnerNameAtom);

  const setupPrice = 30000;
  const shootingPrice = 50000;
  const satueiPrice = 35000;
  const henshuPrice = 15000;

  const setupSub = setupSelected ? setupPrice * setupQty : 0;
  const shootingSub = shootingSelected ? shootingPrice * shootingQty : 0;
  const satueiSub = satueiSelected ? satueiPrice * satueiQty : 0;
  const henshuSub = henshuSelected ? henshuPrice * henshuQty : 0;

  const amount = setupSub + shootingSub + satueiSub + henshuSub;
  const tax = Math.round(amount * 0.1);
  const total = amount + tax;

  const REFERRAL_URL = "https://www.pageit.shop/referral";

  useEffect(() => {
    if (invOwnerName) setName((prev) => (prev ? prev : invOwnerName));
  }, [invOwnerName]);
  useEffect(() => {
    if (invEmail) setEmail((prev) => (prev ? prev : invEmail));
  }, [invEmail]);

  const joinTight = (lines: (string | false | null | undefined)[]) =>
    lines
      .filter((l) => l !== false && l !== null && l !== undefined)
      .reduce<string[]>((acc, raw) => {
        const line = String(raw);
        if (line.trim() === "" && acc[acc.length - 1]?.trim() === "") return acc;
        acc.push(line);
        return acc;
      }, [])
      .join("\n");

  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  const anyQty =
    (setupSelected ? setupQty : 0) +
    (shootingSelected ? shootingQty : 0) +
    (satueiSelected ? satueiQty : 0) +
    (henshuSelected ? henshuQty : 0);

  const clampQty = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  // ボタン色：ライト/ダーク両対応
  const baseBtn =
    "w-full justify-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-400";
  const off =
    "bg-blue-300 hover:bg-blue-500 active:bg-blue-800 text-black " +
    "dark:bg-blue-900/40 dark:hover:bg-blue-900 dark:active:bg-blue-950 dark:text-white";
  const on =
    "bg-blue-700 hover:bg-blue-800 active:bg-blue-900 text-white " +
    "dark:bg-blue-600 dark:hover:bg-blue-500 dark:active:bg-blue-700";

  // 横並びの1行（ボタン＋数量）
  const ItemRow = ({
    label,
    price,
    selected,
    setSelected,
    qty,
    setQty,
  }: {
    label: string;
    price: number;
    selected: boolean;
    setSelected: (v: boolean) => void;
    qty: number;
    setQty: (v: number) => void;
  }) => (
    <div className="flex items-center gap-3">
      <Button
        className={`${baseBtn} ${selected ? on : off} flex-1 h-10`}
        onClick={() => {
          const next = !selected;
          setSelected(next);
          if (next && qty === 0) setQty(1);
          if (!next) setQty(0);
        }}
      >
        {label}（{price.toLocaleString()}円）
      </Button>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm text-gray-700 dark:text-gray-300">数量</span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          disabled={!selected}
          value={selected ? qty : ""}
          placeholder={selected ? "1" : "-"}
          onChange={(e) => setQty(clampQty(Number(e.target.value)))}
          className="w-20 h-10"
        />
      </div>
    </div>
  );

  const handleSend = async () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName || !trimmedEmail || anyQty <= 0) {
      const missing: string[] = [];
      if (!trimmedName) missing.push("お名前");
      if (!trimmedEmail) missing.push("メールアドレス");
      if (anyQty <= 0) missing.push("数量");
      alert(`${missing.join("・")}が未入力です。ご入力・ご選択ください。`);
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      alert("メールアドレスの形式が正しくありません。");
      return;
    }

    // 送信メール本文（紹介制度＆URLを末尾に追記）
    const body = joinTight([
      `${trimmedName}様`,
      "",
      "この度はPageitにお申し込みいただき、誠にありがとうございます。",
      "",
      "以下の内容で初回セットアップ費用のご案内を申し上げます。",
      "",
      "【ご請求内訳】",
      setupSelected && setupQty > 0 &&
        `初期セットアップ：${setupPrice.toLocaleString()}円 × ${setupQty} ＝ ${setupSub.toLocaleString()}円`,
      shootingSelected && shootingQty > 0 &&
        `撮影編集代行　　：${shootingPrice.toLocaleString()}円 × ${shootingQty} ＝ ${shootingSub.toLocaleString()}円`,
      satueiSelected && satueiQty > 0 &&
        `撮影代行　　　　：${satueiPrice.toLocaleString()}円 × ${satueiQty} ＝ ${satueiSub.toLocaleString()}円`,
      henshuSelected && henshuQty > 0 &&
        `編集代行　　　　：${henshuPrice.toLocaleString()}円 × ${henshuQty} ＝ ${henshuSub.toLocaleString()}円`,
      "",
      "【ご請求金額】",
      `税抜小計　　　：${amount.toLocaleString()}円`,
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
      "",
      "――――――――――――――――――",
      "👥 紹介制度（ご成約で1万円）",
      "・対象：新規のお客様（既存・過去問い合わせ済みは対象外）",
      "・お支払い：成約確認・弊社入金確認・クーリングオフ期間経過後、原則7日以内にお振り込み",
      "・複数件OK：成約件数分お支払い",
      "※ 紹介先はお問い合わせ時に「紹介者名」を記載してください。",
      `詳細・申請フォーム：${REFERRAL_URL}`,
    ]);

    try {
      setSending(true);

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
          setupQty,
          shootingQty,
          satueiQty,
          henshuQty,
        }),
      });

      await addDoc(collection(db, "transferLogs"), {
        name: trimmedName,
        email: trimmedEmail,
        setupSelected,
        shootingSelected,
        satueiSelected,
        henshuSelected,
        setupPrice: setupSelected ? setupPrice : 0,
        shootingPrice: shootingSelected ? shootingPrice : 0,
        satueiPrice: satueiSelected ? satueiPrice : 0,
        henshuPrice: henshuSelected ? henshuPrice : 0,
        setupQty,
        shootingQty,
        satueiQty,
        henshuQty,
        setupSub,
        shootingSub,
        satueiSub,
        henshuSub,
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
    <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-neutral-950 p-4">
      <div className="w-full max-w-lg p-4 space-y-4 rounded-2xl shadow bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">振込案内の送信</h1>

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

        <div className="flex flex-col gap-3">
          <ItemRow
            label="初期セットアップ"
            price={setupPrice}
            selected={setupSelected}
            setSelected={setSetupSelected}
            qty={setupQty}
            setQty={setSetupQty}
          />
        <ItemRow
            label="撮影編集代行"
            price={shootingPrice}
            selected={shootingSelected}
            setSelected={setShootingSelected}
            qty={shootingQty}
            setQty={setShootingQty}
          />
          <ItemRow
            label="撮影代行"
            price={satueiPrice}
            selected={satueiSelected}
            setSelected={setSatueiSelected}
            qty={satueiQty}
            setQty={setSatueiQty}
          />
          <ItemRow
            label="編集代行"
            price={henshuPrice}
            selected={henshuSelected}
            setSelected={setHenshuSelected}
            qty={henshuQty}
            setQty={setHenshuQty}
          />
        </div>

        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
          <p>税抜小計　：{amount.toLocaleString()}円</p>
          <p>消費税　　：{tax.toLocaleString()}円</p>
          <p className="font-semibold">税込合計　：{total.toLocaleString()}円</p>
        </div>

       

        <Button onClick={handleSend} disabled={sending || sent}>
          {sending ? "送信中..." : sent ? "送信済み" : "振込案内を送信"}
        </Button>

        {message && <p className="text-gray-700 dark:text-gray-300">{message}</p>}
      </div>
    </main>
  );
}
