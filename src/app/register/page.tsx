// 修正された RegisterPage：Stripe 連携 + 業種登録対応
"use client";

import { useEffect, useState } from "react";
import { auth, db } from "../../lib/firebase";
import { createSiteSettings } from "../../lib/createSiteSettings";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FirebaseError } from "firebase/app";
import { getDoc, doc } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { parsePhoneNumberFromString, AsYouType } from "libphonenumber-js";
import validator from "validator";
import { handleSearchAddress } from "@/lib/addressUtil";

type IndustryOption = { value: string; label: string };

// 業種のプリセット（必要に応じて増減OK）
const INDUSTRY_OPTIONS: IndustryOption[] = [
  { value: "food", label: "飲食" },
  { value: "retail", label: "小売" },
  { value: "beauty", label: "美容・サロン" },
  { value: "medical", label: "医療・介護" },
  { value: "construction", label: "建設・不動産" },
  { value: "it", label: "IT・ソフトウェア" },
  { value: "education", label: "教育・スクール" },
  { value: "logistics", label: "物流・運輸" },
  { value: "manufacturing", label: "製造" },
  { value: "professional", label: "士業" },
  { value: "service", label: "サービス" },
  { value: "other", label: "その他" },
];

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [siteName, setSiteName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [isFreePlan, setIsFreePlan] = useState(false);
  const [postalCode, setPostalCode] = useState("");
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);

  // 追加：業種
  const [industryKey, setIndustryKey] = useState<string>("");     // セレクト値
  const [industryOther, setIndustryOther] = useState<string>(""); // その他の自由入力

  const router = useRouter();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) router.push("/login");
    });
    return () => unsubscribe();
  }, [router]);

  const handleRegister = async () => {
    // バリデーション（簡易）
    if (!validator.isEmail(email)) {
      alert("メールアドレスの形式が正しくありません。");
      return;
    }
    if (password.length < 6) {
      alert("パスワードは6文字以上で入力してください。");
      return;
    }
    if (!/^[a-zA-Z0-9]+$/.test(siteKey)) {
      alert("siteKeyは半角英数字のみで入力してください。");
      return;
    }
    if (!siteName.trim()) {
      alert("サイト名を入力してください。");
      return;
    }
    if (!ownerName.trim()) {
      alert("名前（オーナー）を入力してください。");
      return;
    }
    if (!industryKey) {
      alert("業種を選択してください。");
      return;
    }
    const industryName =
      industryKey === "other"
        ? industryOther.trim()
        : INDUSTRY_OPTIONS.find((o) => o.value === industryKey)?.label || "";
    if (industryKey === "other" && !industryName) {
      alert("「その他の業種」を入力してください。");
      return;
    }

    setLoading(true);
    try {
      const ref = doc(db, "siteSettings", siteKey);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const confirmOverwrite = window.confirm(
          "この siteKey はすでに使われています。上書きしてもよろしいですか？"
        );
        if (!confirmOverwrite) {
          alert("登録をキャンセルしました。");
          return;
        }
      }

      // ✅ サーバー側でFirebase Auth ユーザー作成（自動ログイン防止）
      const userRes = await fetch("/api/create-firebase-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!userRes.ok) {
        const { error } = await userRes.json();

        if (error === "email-already-in-use") {
          alert("このメールアドレスはすでに登録されています。");
          return;
        }
        if (error === "invalid-password") {
          alert("パスワードは6文字以上で入力してください。");
          return;
        }
        throw new Error("Firebaseアカウントの作成に失敗しました");
      }

      const { uid } = await userRes.json();

      let customerId: string | null = null;
      let subscriptionId: string | null = null;

      // Stripe 顧客作成（無料プランでない場合）
      if (!isFreePlan) {
        const stripeRes = await fetch("/api/stripe/create-stripe-customer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name: ownerName,
            metadata: {
              siteKey,
              siteName,
              ownerPhone,
              industryKey,
              industryName,
            },
          }),
        });

        if (!stripeRes.ok) {
          throw new Error("Stripeの登録に失敗しました");
        }

        const json = await stripeRes.json();
        customerId = json.customerId;
        subscriptionId = json.subscriptionId;
      }

      // Firestore に siteSettings を保存（業種を含める）
      await createSiteSettings(siteKey, {
        ownerId: uid,
        siteName,
        siteKey,
        ownerName,
        ownerAddress,
        ownerEmail: email,
        ownerPhone,
        isFreePlan,
        industry: { key: industryKey, name: industryName }, // ← 追加
        ...(customerId && { stripeCustomerId: customerId }),
        ...(subscriptionId && { stripeSubscriptionId: subscriptionId }),
        setupMode: false,
      });

      alert("登録が完了しました！");
      // 入力リセット
      setEmail("");
      setPassword("");
      setSiteKey("");
      setSiteName("");
      setOwnerName("");
      setOwnerAddress("");
      setOwnerPhone("");
      setPostalCode("");
      setIsFreePlan(false);
      setIndustryKey("");
      setIndustryOther("");
    } catch (e) {
      if (e instanceof FirebaseError) {
        alert(
          e.code === "auth/email-already-in-use"
            ? "このメールアドレスはすでに登録されています。"
            : "登録時にエラーが発生しました: " + e.message
        );
      } else {
        alert("不明なエラーが発生しました。");
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] gap-6 p-8">
      {/* プラン切替 */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="freePlan"
          checked={isFreePlan}
          onChange={(e) => setIsFreePlan(e.target.checked)}
        />
        <label htmlFor="freePlan">無料プランにする（Stripe連携しない）</label>
      </div>

      <Card className="w-full max-w-md shadow-lg">
        <CardHeader>
          <CardTitle>アカウント登録</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* メール */}
          <Input
            type="email"
            placeholder="メールアドレス"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {email && (
            <p
              className={`text-sm ${
                validator.isEmail(email) ? "text-green-600" : "text-red-600"
              }`}
            >
              {validator.isEmail(email)
                ? "✅ 有効なメールアドレス形式です"
                : "⚠️ メールアドレスの形式が不正です"}
            </p>
          )}

          {/* パスワード */}
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="パスワード（6文字以上）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              onClick={() => setPassword(Math.random().toString(36).slice(-10))}
            >
              自動生成
            </Button>
          </div>

          {/* siteKey */}
          <Input
            type="text"
            placeholder="siteKey（英数字）"
            value={siteKey}
            onChange={(e) => setSiteKey(e.target.value)}
          />
          {siteKey && (
            <p
              className={`text-sm ${
                /^[a-zA-Z0-9]+$/.test(siteKey)
                  ? "text-green-600"
                  : "text-red-600"
              }`}
            >
              {/^[a-zA-Z0-9]+$/.test(siteKey)
                ? "✅ 半角英数字の形式です"
                : "⚠️ siteKeyは半角英数字のみで入力してください"}
            </p>
          )}

          {/* サイト名・オーナー名 */}
          <Input
            type="text"
            placeholder="サイト名"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
          />
          <Input
            type="text"
            placeholder="名前（オーナー）"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
          />

          {/* 郵便番号 → 住所検索 */}
          <Input
            type="text"
            placeholder="郵便番号（例: 123-4567）"
            maxLength={8}
            value={postalCode}
            onChange={(e) => {
              let input = e.target.value.replace(/[^\d]/g, "");
              if (input.length > 3) input = `${input.slice(0, 3)}-${input.slice(3, 7)}`;
              setPostalCode(input);
            }}
            onBlur={() => {
              const formattedZipCode = postalCode.replace("-", "");
              (async () => {
                await handleSearchAddress(
                  formattedZipCode,
                  setOwnerAddress,
                  setIsSearchingAddress
                );
              })();
            }}
          />
          {isSearchingAddress && (
            <p className="text-sm text-gray-500">住所を検索中...</p>
          )}
          <Input
            type="text"
            placeholder="住所"
            value={ownerAddress}
            onChange={(e) => setOwnerAddress(e.target.value)}
          />

          {/* 電話番号 */}
          <div className="space-y-1">
            <Input
              type="tel"
              placeholder="電話番号（例: 09012345678）"
              value={ownerPhone}
              onChange={(e) => {
                const input = e.target.value;
                const formatted = new AsYouType("JP").input(input);
                setOwnerPhone(formatted);
              }}
            />
            {ownerPhone && (
              <p className="text-sm text-gray-500">
                {parsePhoneNumberFromString(ownerPhone, "JP")?.isValid()
                  ? "✅ 有効な電話番号です"
                  : "⚠️ 無効な形式の電話番号です"}
              </p>
            )}
          </div>

          {/* 🆕 業種（セレクト + その他入力） */}
          <div className="space-y-2">
            <label className="text-sm text-gray-700">業種</label>
            <select
              value={industryKey}
              onChange={(e) => setIndustryKey(e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <option value="" disabled>
                選択してください
              </option>
              {INDUSTRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {industryKey === "other" && (
              <Input
                type="text"
                placeholder="その他の業種を入力"
                value={industryOther}
                onChange={(e) => setIndustryOther(e.target.value)}
              />
            )}
          </div>

          {/* 登録ボタン */}
          <Button onClick={handleRegister} disabled={loading} className="w-full">
            {loading ? "登録中..." : "登録する"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
