import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

/** 住所・電話・メールを公開用に残す店舗です。特商法ページを配信している店舗をオーナーが選びました。 */
const CONTACT_PUBLIC_SITE_KEYS = new Set([
  "dslab571",
  "ecoroOsouji",
  "fukugenyaguide225",
  "megNekoneote",
  "pageit",
  "tayotteya3110",
  "venusTotalBeaty",
  "yotteya",
]);

const SHARED_FIELDS = [
  "siteName",
  "ownerName",
  "businessHours",
  "homepageUrl",
  "industry",
  "seoTagline",
  "seoDescription",
  "isFreePlan",
  "setupMode",
];
const CONTACT_FIELDS = ["ownerAddress", "ownerEmail", "ownerPhone"];

/** siteSettings の内容を、未ログインでも読める sitePublicProfile へ写します。 */
export async function syncSitePublicProfile(siteKey: string) {
  const snap = await getDoc(doc(db, "siteSettings", siteKey));
  const settings = snap.data() ?? {};
  const fields = CONTACT_PUBLIC_SITE_KEYS.has(siteKey)
    ? [...SHARED_FIELDS, ...CONTACT_FIELDS]
    : SHARED_FIELDS;
  const profile: Record<string, unknown> = { updatedAt: serverTimestamp() };
  for (const field of fields) {
    if (settings[field] !== undefined) profile[field] = settings[field];
  }
  await setDoc(doc(db, "sitePublicProfile", siteKey), profile, { merge: true });
}

export async function deleteSitePublicProfile(siteKey: string) {
  await deleteDoc(doc(db, "sitePublicProfile", siteKey));
}
