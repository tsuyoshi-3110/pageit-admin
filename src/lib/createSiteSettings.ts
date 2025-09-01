// lib/createSiteSettings.ts
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

/** 業種情報（任意） */
export type IndustryInfo = {
  key: string;   // 例: "food" | "it" | "other"
  name: string;  // 例: "飲食" や "IT・ソフトウェア"、その他自由入力
};

/** siteSettings に保存するデータの型 */
export type SiteSettingsInput = {
  ownerId: string;
  siteName: string;
  siteKey: string;
  ownerName: string;
  ownerAddress: string;
  ownerPhone: string;
  ownerEmail: string;
  homepageUrl?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  isFreePlan: boolean;
  setupMode?: boolean;
  industry?: IndustryInfo; // ← 追加（任意）
};

/** オプション：既存ドキュメントがある場合の確認ダイアログを有効化するか */
export type CreateSiteSettingsOptions = {
  askConfirmIfExists?: boolean; // デフォルト false（呼び出し元ですでに確認しているケースを想定）
};

/**
 * siteSettings ドキュメントを作成/更新します。
 * - 既存が無ければ createdAt を付与
 * - 常に updatedAt を更新
 * - merge: true で部分更新対応
 * - ブラウザ環境かつ askConfirmIfExists=true の場合、既存時に上書き確認ダイアログを表示
 */
export async function createSiteSettings(
  siteId: string,
  data: SiteSettingsInput,
  options: CreateSiteSettingsOptions = {}
): Promise<boolean> {
  const { askConfirmIfExists = false } = options;

  const ref = doc(db, "siteSettings", siteId);
  const existingDoc = await getDoc(ref);

  if (existingDoc.exists() && askConfirmIfExists) {
    // SSR/Edge対策：window が使えるときのみ確認ダイアログ
    if (typeof window !== "undefined") {
      const shouldOverwrite = window.confirm(
        "この siteKey はすでに存在します。上書きしますか？"
      );
      if (!shouldOverwrite) return false;
    }
  }

  await setDoc(
    ref,
    {
      ...data,
      ...(existingDoc.exists() ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return true;
}
