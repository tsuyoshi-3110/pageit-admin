import assert from "node:assert/strict";
import { createFakes } from "@/lib/provisioning/testing/fakes";
import type { RawTenantInput } from "@/lib/provisioning/input";
import { parseTenantInput } from "@/lib/provisioning/input";
import type { TenantInput } from "@/lib/provisioning/types";

const projectId = process.env.FIREBASE_PROJECT_ID ?? "";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "";

// 本番へ接続しないための確認です。条件を満たさなければテストを始めません。
assert.ok(projectId.startsWith("demo-"), "demo- プロジェクト以外では実行しません");
assert.ok(authHost.startsWith("127.0.0.1:"), "Authエミュレーターが必要です");
assert.ok(firestoreHost.startsWith("127.0.0.1:"), "Firestoreエミュレーターが必要です");
assert.ok(!process.env.VERCEL_TOKEN, "本物のVERCEL_TOKENがあると実行しません");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.hostname, "127.0.0.1", `外部への接続を止めました: ${url.hostname}`);
  return realFetch(input, init);
}) as typeof fetch;

export async function clearEmulators() {
  const firestore = await realFetch(
    `http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(firestore.ok);
  const auth = await realFetch(`http://${authHost}/emulator/v1/projects/${projectId}/accounts`, {
    method: "DELETE",
    headers: { Authorization: "Bearer owner" },
  });
  assert.ok(auth.ok);
}

export async function signIn(email: string, password: string): Promise<string> {
  const response = await realFetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await response.json();
  assert.ok(data.idToken, "サインインに失敗しました");
  return data.idToken;
}

export function rawInput(overrides: RawTenantInput = {}): RawTenantInput {
  return {
    siteName: "さくらベーカリー",
    siteKey: "sakura-bakery",
    domain: "sakura-bakery.example",
    wwwEnabled: true,
    ownerEmail: "owner@sakura-bakery.example",
    industryKey: "food",
    plan: "paid",
    ...overrides,
  };
}

export function tenantInput(overrides: RawTenantInput = {}): TenantInput {
  const parsed = parseTenantInput(rawInput(overrides));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.input;
}

export { createFakes };
