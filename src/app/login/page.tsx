// app/(whatever)/login/page.tsx など
"use client";

import { useEffect, useState } from "react";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  User,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { auth, db } from "../../lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LogOut, LucideLogIn, AlertCircle } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [user, setUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true); // 権限チェック中のフラグ
  const [dark, setDark] = useState(false);

  // テーマ
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // 認証状態 + 管理者チェック
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setCheckingAuth(true);
      if (!firebaseUser) {
        setUser(null);
        setCheckingAuth(false);
        return;
      }
      try {
        const adminRef = doc(db, "admins", firebaseUser.uid);
        const adminSnap = await getDoc(adminRef);
        if (adminSnap.exists()) {
          setUser(firebaseUser);
        } else {
          // 管理者でなければログアウトさせる
          await signOut(auth);
          setUser(null);
          setError("このアカウントには管理者権限がありません。");
        }
      } catch {
        await signOut(auth);
        setUser(null);
        setError("権限の確認に失敗しました。時間をおいて再度お試しください。");
      } finally {
        setCheckingAuth(false);
      }
    });
    return () => unsub();
  }, []);

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      // ここで admins/{uid} の存在チェック
      const adminRef = doc(db, "admins", uid);
      const adminSnap = await getDoc(adminRef);
      if (!adminSnap.exists()) {
        await signOut(auth);
        setUser(null);
        setError("このアカウントには管理者権限がありません。");
        return;
      }

      // OK（onAuthStateChanged側でもセットされるが念のため）
      setUser(cred.user);
    } catch (err) {
      if (err instanceof FirebaseError) {
        switch (err.code) {
          case "auth/invalid-email":
            setError("メールアドレスの形式が正しくありません。");
            break;
          case "auth/user-not-found":
            setError("このメールアドレスは登録されていません。");
            break;
          case "auth/wrong-password":
            setError("パスワードが間違っています。");
            break;
          default:
            setError("ログインに失敗しました。");
        }
      } else {
        setError("不明なエラーが発生しました。");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
  };

  // 権限チェック中は空表示（必要ならローディングUIを）
  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-120px)] p-8 text-sm text-gray-500">
        権限を確認中…
      </div>
    );
  }

  // ログイン後（管理者のみここに来る）
  if (user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] gap-6 p-8">
        <button
          onClick={() => setDark(!dark)}
          className="mt-4 p-2 border rounded bg-gray-200 dark:bg-gray-800"
        >
          ダークモードを{dark ? "解除" : "有効化"}
        </button>
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <LogOut size={20} /> ログアウト
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p>{user.email} としてログイン中です。</p>
            <Button onClick={handleLogout} className="w-full bg-blue-500">
              ログアウト
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 未ログイン or 非管理者
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] gap-6 p-8">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <LucideLogIn size={20} /> ログイン
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>ログインエラー</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Input
            type="email"
            placeholder="メールアドレス"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="パスワード"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            onClick={handleLogin}
            disabled={loading}
            className="w-full bg-blue-500"
          >
            {loading ? "ログイン中..." : "ログイン"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
