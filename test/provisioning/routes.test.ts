import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import * as item from "@/app/api/admin/tenants/[siteKey]/route";
import * as runRoute from "@/app/api/admin/tenants/[siteKey]/run/route";
import * as collection from "@/app/api/admin/tenants/route";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { getSharedFakes } from "@/lib/provisioning/testing/fakes";
import { clearEmulators, rawInput, signIn } from "./helpers";

// 本物のAPIルートを、偽の外部サービスとエミュレーターで動かします
process.env.PROVISIONING_FAKE_EXTERNALS = "1";

const SITE = "sakura-bakery";
const DOMAIN = "sakura-bakery.example";
const context = { params: Promise.resolve({ siteKey: SITE }) };
const BASE = "http://localhost/api/admin/tenants";
const PASSWORD = `test-${Date.now()}`;

function request(path: string, method: string, token?: string, body?: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const endpoints = [
  ["GET 一覧", (token?: string) => collection.GET(request("", "GET", token))],
  ["POST 開始", (token?: string) => collection.POST(request("", "POST", token, rawInput()))],
  ["GET 進行状況", (token?: string) => item.GET(request(`/${SITE}`, "GET", token), context)],
  ["DELETE 破棄", (token?: string) => item.DELETE(request(`/${SITE}`, "DELETE", token), context)],
  ["POST 実行", (token?: string) => runRoute.POST(request(`/${SITE}/run`, "POST", token, {}), context)],
] as const;

async function createUsers() {
  await adminAuth.createUser({ uid: "admin-uid", email: "admin@example.test", password: PASSWORD });
  await adminAuth.createUser({ uid: "plain-uid", email: "plain@example.test", password: PASSWORD });
  await adminDb.doc("admins/admin-uid").set({ role: "admin" });
}

async function sideEffects() {
  const fakes = getSharedFakes();
  return {
    runs: (await adminDb.collection("tenantProvisioning").get()).size,
    calls: fakes.calls.length,
  };
}

describe("API", () => {
  let adminToken: string;
  let plainToken: string;

  before(() => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  });

  beforeEach(async () => {
    await clearEmulators();
    await createUsers();
    adminToken = await signIn("admin@example.test", PASSWORD);
    plainToken = await signIn("plain@example.test", PASSWORD);
    delete (globalThis as any).__pageitProvisioningFakes;
  });

  for (const [name, call] of endpoints) {
    test(`${name}: 未ログインは401で、何も実行しない`, async () => {
      const response = await call();
      assert.equal(response.status, 401);
      assert.deepEqual(await sideEffects(), { runs: 0, calls: 0 });
    });

    test(`${name}: 不正なトークンは401`, async () => {
      const response = await call("not-a-token");
      assert.equal(response.status, 401);
      assert.deepEqual(await sideEffects(), { runs: 0, calls: 0 });
    });

    test(`${name}: 管理者以外は403で、何も実行しない`, async () => {
      const response = await call(plainToken);
      assert.equal(response.status, 403);
      assert.deepEqual(await sideEffects(), { runs: 0, calls: 0 });
    });
  }

  test("不正な入力は400で項目ごとに返す", async () => {
    const response = await collection.POST(
      request("", "POST", adminToken, rawInput({ siteKey: "BAD KEY", ownerEmail: "x" }))
    );
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.errors.siteKey);
    assert.ok(data.errors.ownerEmail);
    assert.deepEqual(await sideEffects(), { runs: 0, calls: 0 });
  });

  test("使用済みなら409で理由を返し、既存を変えない", async () => {
    await adminDb.doc(`domains/${DOMAIN}`).set({ siteKey: "other" });
    const response = await collection.POST(request("", "POST", adminToken, rawInput()));
    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.conflicts[0].field, "domain");
    assert.equal((await adminDb.doc(`domains/${DOMAIN}`).get()).get("siteKey"), "other");
    assert.equal((await sideEffects()).runs, 0);
  });

  test("設定不足なら503で項目名だけ返し、本物の外部サービスへ接続しない", async () => {
    delete process.env.PROVISIONING_FAKE_EXTERNALS;
    try {
      const response = await collection.POST(request("", "POST", adminToken, rawInput()));
      assert.equal(response.status, 503);
      const data = await response.json();
      assert.ok(data.problems.some((item: string) => item.includes("VERCEL_TOKEN")));
      assert.ok(data.problems.some((item: string) => item.includes("PROVISION_VERCEL_ENV_MODE")));
      assert.ok(!JSON.stringify(data).includes("sk_test_dummy_not_used"));
      assert.equal((await adminDb.collection("tenantProvisioning").get()).size, 0);
    } finally {
      process.env.PROVISIONING_FAKE_EXTERNALS = "1";
    }
  });

  test("ロック情報を画面へ返さない", async () => {
    const response = await collection.POST(request("", "POST", adminToken, rawInput()));
    assert.equal(response.status, 201);
    assert.ok(!("lock" in (await response.json()).run));
  });

  test("最初から最後まで: 途中失敗と画面の閉じ直しを含めて公開まで進む", async () => {
    const fakes = getSharedFakes();
    fakes.vercelState.dnsChecksUntilReady = null;
    fakes.vercelState.pollsUntilReady = 2;
    fakes.failOnce("vercel.createProject", "Vercelの模擬障害");
    const log: string[] = [];
    const call = async (options: object) => {
      const response = await runRoute.POST(request(`/${SITE}/run`, "POST", adminToken, options), context);
      assert.equal(response.status, 200);
      return (await response.json()).run;
    };
    const record = (view: any) => {
      const running = Object.entries<any>(view.steps)
        .filter(([, step]) => ["failed", "waiting"].includes(step.status))
        .map(([id, step]) => `${id}:${step.status}`);
      log.push(`${view.status} ${running.join(",")}`.trim());
      return view;
    };
    const drive = async (first: object = {}) => {
      let view = record(await call(first));
      while (view.status === "in_progress" || (view.status === "waiting" && view.retryAfterMs)) {
        view = record(await call({}));
      }
      return view;
    };

    const created = await collection.POST(request("", "POST", adminToken, rawInput()));
    assert.equal(created.status, 201);

    // Vercelの障害で止まる
    let view = await drive();
    assert.equal(view.status, "failed");
    assert.equal(view.steps.vercelProject.error.message, "Vercel: Vercelの模擬障害");

    // 画面を閉じて開き直す: 一覧と進行状況から確認できる
    const listed = await (await collection.GET(request("", "GET", adminToken))).json();
    assert.equal(listed.runs[0].siteKey, SITE);
    const reopened = await (await item.GET(request(`/${SITE}`, "GET", adminToken), context)).json();
    assert.equal(reopened.run.steps.firestore.status, "done");

    // 再開するとDNS待ちまで進み、DNSの値が見える
    view = await drive({ resume: true });
    assert.equal(view.status, "waiting");
    assert.equal(view.steps.dns.status, "waiting");
    assert.equal(view.resources.dns.hosts.length, 2);
    assert.equal(fakes.mails.length, 0);

    // DNS反映後の再確認で案内メールまで完了する
    fakes.vercelState.dnsReady = true;
    view = await drive({});
    assert.equal(view.status, "completed");

    assert.equal(fakes.vercelState.projects.length, 1);
    assert.equal(fakes.vercelState.deployments.length, 1);
    assert.equal(fakes.stripeState.subscriptions.length, 1);
    assert.equal(fakes.mails.length, 1);

    const owner = await adminAuth.getUserByEmail("owner@sakura-bakery.example");
    assert.equal(owner.passwordHash, undefined);
    assert.equal((await adminDb.doc(`siteSettings/${SITE}`).get()).get("ownerId"), owner.uid);
    const remaining = await (await collection.GET(request("", "GET", adminToken))).json();
    assert.equal(remaining.runs.length, 0);

    // store-main のビルド処理が、作成したデータから店舗設定を組み立てられること
    const platform = "/Users/saitoutsuyoshi/dev/pageit/customer/pageit-platform";
    if (existsSync(platform)) {
      const source = execFileSync("git", ["-C", platform, "show", "store-main:scripts/lib/store-config.mjs"]);
      const file = join(mkdtempSync(join(tmpdir(), "store-config-")), "store-config.mjs");
      writeFileSync(file, source);
      const { buildStoreConfig } = await import(pathToFileURL(file).href);
      const [site, settings, editable] = await Promise.all([
        adminDb.doc(`sites/${SITE}`).get(),
        adminDb.doc(`siteSettings/${SITE}`).get(),
        adminDb.doc(`siteSettingsEditable/${SITE}`).get(),
      ]);
      const config = buildStoreConfig({
        siteKey: SITE,
        site: site.data(),
        settings: settings.data(),
        editable: editable.data(),
        env: { VERCEL_URL: "pageit-sakura-bakery.vercel.app" },
      });
      assert.equal(config.siteKey, SITE);
      assert.equal(config.productionUrl, `https://${DOMAIN}`);
      assert.equal(config.brand.name, "さくらベーカリー");
      assert.equal(config.brand.businessCategory, "飲食");
      log.push("store-config OK");
    }

    console.log(`通し実行の記録:\n  ${log.join("\n  ")}`);
  });
});
