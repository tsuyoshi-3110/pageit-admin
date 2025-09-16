"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addDoc, collection } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAtomValue } from "jotai";
import { invEmailAtom, invOwnerNameAtom } from "@/lib/atoms/openFlagAtom";

type ProductKey = "setup" | "shooting" | "satuei" | "henshu" | "full";

export default function SendTransferPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // 「どれか一つだけ」選択
  const [selected, setSelected] = useState<ProductKey | null>(null);

  // 数量（各商品ごとに保持。選択中のものだけ使う）
  const [qty, setQty] = useState<Record<ProductKey, number>>({
    setup: 0,
    shooting: 0,
    satuei: 0,
    henshu: 0,
    full: 0,
  });

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  const invEmail = useAtomValue(invEmailAtom);
  const invOwnerName = useAtomValue(invOwnerNameAtom);

  // 価格
  const PRICES: Record<ProductKey, number> = {
    setup: 30000,   // 初期設定
    shooting: 50000, // 撮影編集代行
    satuei: 35000,  // 撮影代行
    henshu: 15000,  // 編集代行
    full: 80000,    // フルセット（必要に応じて調整OK）
  };

  // 表示名
  const LABELS: Record<ProductKey, string> = {
    setup: "初期設定",
    shooting: "撮影編集代行",
    satuei: "撮影代行",
    henshu: "編集代行",
    full: "フルセット",
  };

  // Stripe Payment Links
  const LINKS: Record<ProductKey, string> = {
    setup: "https://buy.stripe.com/28EcN6flK0p19V52jaefC02",
    henshu: "https://buy.stripe.com/9B6bJ28Xm0p1gjt0b2efC03",
    satuei: "https://buy.stripe.com/00w5kEehG9ZB7MX5vmefC04",
    shooting: "https://buy.stripe.com/6oUcN60qQ4Fh8R14riefC06",
    full: "https://buy.stripe.com/cNi7sMflKgnZ7MXe1SefC07",
  };

  const REFERRAL_URL = "https://www.pageit.shop/referral";

  // 初期値（自動入力）
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

  const clampQty = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  // 金額計算（選択中のみ）
  const { subTotal, tax, total } = useMemo(() => {
    if (!selected) return { subTotal: 0, tax: 0, total: 0 };
    const subtotal = PRICES[selected] * (qty[selected] || 0);
    const t = Math.round(subtotal * 0.1);
    return { subTotal: subtotal, tax: t, total: subtotal + t };
  }, [selected, qty, PRICES]);

  // 1行（ラジオ挙動）
  const ItemRow = ({ keyName }: { keyName: ProductKey }) => {
    const active = selected === keyName;
    const label = LABELS[keyName];
    const price = PRICES[keyName];

    return (
      <div className="flex items-center gap-3">
        <Button
          className={`${"w-full justify-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-400"} ${
            active
              ? "bg-blue-700 hover:bg-blue-800 active:bg-blue-900 text-white dark:bg-blue-600 dark:hover:bg-blue-500 dark:active:bg-blue-700"
              : "bg-blue-300 hover:bg-blue-500 active:bg-blue-800 text-black dark:bg-blue-900/40 dark:hover:bg-blue-900 dark:active:bg-blue-950 dark:text-white"
          } flex-1 h-10`}
          onClick={() => {
            // 同じボタンをもう一度押したら解除、それ以外は切り替え
            setSelected((prev) => (prev === keyName ? null : keyName));
            setQty((prev) => {
              const next = { ...prev };
              if (selected !== keyName && prev[keyName] === 0) next[keyName] = 1; // 選択時に数量1を初期セット
              return next;
            });
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
            disabled={!active}
            value={active ? qty[keyName] || "" : ""}
            placeholder={active ? "1" : "-"}
            onChange={(e) =>
              setQty((prev) => ({ ...prev, [keyName]: clampQty(Number(e.target.value)) }))
            }
            className="w-20 h-10"
          />
        </div>
      </div>
    );
  };

  const handleSend = async () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    const selectedQty = selected ? qty[selected] || 0 : 0;

    if (!trimmedName || !trimmedEmail || !selected || selectedQty <= 0) {
      const missing: string[] = [];
      if (!trimmedName) missing.push("お名前");
      if (!trimmedEmail) missing.push("メールアドレス");
      if (!selected) missing.push("商品選択");
      if (selected && selectedQty <= 0) missing.push("数量");
      alert(`${missing.join("・")}が未入力です。ご入力・ご選択ください。`);
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      alert("メールアドレスの形式が正しくありません。");
      return;
    }

    // メール本文（受け取り側へ数量注意を含める）
    const label = LABELS[selected];
    const unitPrice = PRICES[selected];
    const link = LINKS[selected];

    const payLine =
      `・${label}：${link}` +
      (selectedQty > 1 ? `（※数量を ${selectedQty} に変更してお支払いください）` : "");

    const body = joinTight([
      `${trimmedName}様`,
      "",
      "この度はPageitにお申し込みいただき、誠にありがとうございます。",
      "",
      "以下の内容でご請求のご案内を申し上げます。",
      "",
      "【ご請求内訳】",
      `${label}：${unitPrice.toLocaleString()}円 × ${selectedQty} ＝ ${(unitPrice * selectedQty).toLocaleString()}円`,
      "",
      "【ご請求金額】",
      `税抜小計：${subTotal.toLocaleString()}円`,
      `消費税　：${tax.toLocaleString()}円`,
      `税込合計：${total.toLocaleString()}円`,
      "",
      "【お支払い方法】",
      "1) 銀行振込",
      "　銀行名：三菱東京UFJ銀行",
      "　支店名：新大阪支店",
      "　口座種別：普通",
      "　口座番号：5002177",
      "　口座名義：サイトウ　ツヨシ",
      "",
      "2) クレジットカード決済（Stripe）",
      "　下記リンクより該当商品をご選択のうえ、お手続きください。",
      "　※Stripeの数量は本メールと連動しません。数量が2以上の場合は、決済ページ内の数量を上記の数量に変更してからお支払いください。",
      payLine,
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

      // 既存APIに「選択したものだけ true」で渡す
      await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: trimmedEmail,
          subject: "【Pageit】請求書（銀行振込／カード決済のご案内）",
          body,
          name: trimmedName,

          // 各フラグ（選択したものだけ true）
          setupSelected: selected === "setup",
          shootingSelected: selected === "shooting",
          satueiSelected: selected === "satuei",
          henshuSelected: selected === "henshu",
          fullSelected: selected === "full",

          // 数量（選択したものだけ数値、他は0）
          setupQty: selected === "setup" ? selectedQty : 0,
          shootingQty: selected === "shooting" ? selectedQty : 0,
          satueiQty: selected === "satuei" ? selectedQty : 0,
          henshuQty: selected === "henshu" ? selectedQty : 0,
          fullQty: selected === "full" ? selectedQty : 0,
        }),
      });

      // Firestore ログ
      await addDoc(collection(db, "transferLogs"), {
        name: trimmedName,
        email: trimmedEmail,
        selected,
        qty: selectedQty,
        price: unitPrice,
        subTotal,
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
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">請求メールの送信</h1>

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
          <ItemRow keyName="setup" />
          <ItemRow keyName="shooting" />
          <ItemRow keyName="satuei" />
          <ItemRow keyName="henshu" />
          <ItemRow keyName="full" />
        </div>

        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
          <p>税抜小計　：{subTotal.toLocaleString()}円</p>
          <p>消費税　　：{tax.toLocaleString()}円</p>
          <p className="font-semibold">税込合計　：{total.toLocaleString()}円</p>
        </div>

        <Button onClick={handleSend} disabled={sending || sent}>
          {sending ? "送信中..." : sent ? "送信済み" : "請求メールを送信"}
        </Button>

        {message && <p className="text-gray-700 dark:text-gray-300">{message}</p>}
      </div>
    </main>
  );
}
