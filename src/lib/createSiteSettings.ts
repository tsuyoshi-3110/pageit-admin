import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

export async function createSiteSettings(
  siteId: string,
  data: {
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
  }
) {
  const ref = doc(db, "siteSettings", siteId);
  const existingDoc = await getDoc(ref);

  // すでに存在する場合、ユーザーに上書き確認
  if (existingDoc.exists()) {
    const shouldOverwrite = window.confirm(
      "この siteKey はすでに存在します。上書きしますか？"
    );
    if (!shouldOverwrite) {
      return false;
    }
  }

  await setDoc(
    ref,
    {
      ...data,
      // createdAtは新規作成時のみ追加
      ...(existingDoc.exists() ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return true;
}
