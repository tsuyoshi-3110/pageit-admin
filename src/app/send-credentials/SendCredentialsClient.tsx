"use client";

import {  useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";

export default function SendCredentialsClient() {
  const searchParams = useSearchParams();
  const initialEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const handleSend = async () => {
    setLoading(true);
    setMessage("");

    try {
      const res = await fetch("/api/send-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        setMessage("✅ メールを送信しました。");

        // Firestore に送信ログを保存
        await addDoc(collection(db, "credentialsSentLogs"), {
          email,
          sentAt: serverTimestamp(),
        });
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(`❌ 送信に失敗しました。${data?.error ?? ""}`);
      }
    } catch (err) {
      console.error("送信エラー:", err);
      setMessage("❌ ネットワークエラーが発生しました。");
    }

    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto py-8 space-y-4">
      <h1 className="text-xl font-bold">ログイン情報を送信</h1>

      <Input
        type="email"
        placeholder="宛先メールアドレス"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Input
        type="text"
        placeholder="初期パスワード"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Button onClick={handleSend} disabled={loading || !email || !password}>
        {loading ? "送信中..." : "送信する"}
      </Button>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
