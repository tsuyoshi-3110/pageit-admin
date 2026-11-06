import { auth } from "@/lib/firebase";

/** ログイン中の管理者のIDトークンを付けてAPIを呼び出します。 */
export async function authedFetch(input: string, init: RequestInit = {}) {
  await auth.authStateReady();
  const token = await auth.currentUser?.getIdToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
