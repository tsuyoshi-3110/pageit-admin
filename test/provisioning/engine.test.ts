import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { findConfigProblems } from "@/lib/provisioning/config";
import {
  advance,
  discardProvisioning,
  getProvisioning,
  ProvisioningConflictError,
  startProvisioning,
} from "@/lib/provisioning/engine";
import { parseTenantInput } from "@/lib/provisioning/input";
import type { ProvisioningRun, ProvisioningView, StepId } from "@/lib/provisioning/types";
import { clearEmulators, createFakes, rawInput, tenantInput } from "./helpers";

const SITE = "sakura-bakery";
const DOMAIN = "sakura-bakery.example";
const EMAIL = "owner@sakura-bakery.example";

let fakes: ReturnType<typeof createFakes>;
let deps: ReturnType<ReturnType<typeof createFakes>["deps"]>;

beforeEach(async () => {
  await clearEmulators();
  fakes = createFakes();
  deps = fakes.deps(adminDb, adminAuth);
});

const runDoc = () => adminDb.doc(`tenantProvisioning/${SITE}`);
const readRun = async () => (await runDoc().get()).data() as ProvisioningRun;
const opCount = (op: string) => fakes.calls.filter((call) => call.op === op).length;

/** 止まるまで（失敗・待機・完了）手順を進めます */
async function runUntilStop(options: { resume?: boolean } = {}) {
  let current = await advance(deps, SITE, options);
  while (current?.status === "in_progress") current = await advance(deps, SITE);
  return current as ProvisioningView;
}

/** デプロイ待ちを越えて、DNS待ちか失敗か完了まで進めます */
async function runPastDeployment(options: { resume?: boolean } = {}) {
  let current = await runUntilStop(options);
  while (current.status === "waiting" && current.retryAfterMs) current = await runUntilStop();
  return current;
}

async function runToCompletion(options: { resume?: boolean } = {}) {
  fakes.vercelState.dnsReady = true;
  return runPastDeployment(options);
}

/** 手順の実行後、記録を保存する前に落ちた状況を作ります */
async function forgetStep(stepId: StepId, resources: Record<string, unknown> = {}) {
  const updates: Record<string, unknown> = {
    status: "in_progress",
    [`steps.${stepId}.status`]: "pending",
  };
  for (const [key, value] of Object.entries(resources)) updates[`resources.${key}`] = value;
  await runDoc().update(updates);
}

async function runStepsThrough(last: StepId) {
  let current: ProvisioningView | null = null;
  do {
    current = await advance(deps, SITE);
  } while (current && current.steps[last].status !== "done" && current.steps[last].status !== "skipped");
  return current as ProvisioningView;
}

describe("入力チェックと設定", () => {
  test("正しい入力を正規化する", () => {
    const parsed = parseTenantInput(
      rawInput({ domain: " Sakura-Bakery.Example ", ownerEmail: "OWNER@Sakura-Bakery.example" })
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.input.domain, DOMAIN);
    assert.equal(parsed.input.ownerEmail, EMAIL);
    assert.deepEqual(parsed.input.industry, { key: "food", name: "飲食" });
  });

  for (const [name, overrides, field] of [
    ["大文字の店舗キー", { siteKey: "Sakura" }, "siteKey"],
    ["ハイフンの連続", { siteKey: "a--b" }, "siteKey"],
    ["パス区切り", { siteKey: "a/b" }, "siteKey"],
    ["wwwつきドメイン", { domain: "www.example.com" }, "domain"],
    ["URL形式のドメイン", { domain: "https://example.com" }, "domain"],
    ["不正なメール", { ownerEmail: "owner" }, "ownerEmail"],
    ["プラン未選択", { plan: "" }, "plan"],
    ["業種未選択", { industryKey: "" }, "industry"],
    ["その他の業種が空", { industryKey: "other", industryOther: " " }, "industryOther"],
  ] as const) {
    test(`拒否: ${name}`, () => {
      const parsed = parseTenantInput(rawInput(overrides as any));
      assert.ok(!parsed.ok);
      assert.ok((parsed.errors as any)[field]);
    });
  }

  test("足りない設定を名前だけで返す", () => {
    const problems = findConfigProblems(
      { VERCEL_TOKEN: "secret-token-value", PROVISION_VERCEL_ENV_MODE: "copy", PROVISION_VERCEL_COPY_ENV_KEYS: "A_KEY" },
      { plan: "paid" }
    );
    assert.ok(problems.includes("STRIPE_SECRET_KEY が未設定です"));
    assert.ok(problems.some((item) => item.includes("A_KEY")));
    assert.ok(!problems.join().includes("secret-token-value"));
    assert.ok(findConfigProblems({}, { plan: "free" }).every((item) => !item.includes("STRIPE")));
    assert.ok(findConfigProblems({}, { plan: "free" }).some((item) => item.includes("PROVISION_VERCEL_ENV_MODE")));
  });
});

describe("手順ごとの処理", () => {
  test("有料プラン: 各手順が仕様どおりに作成する", async () => {
    await startProvisioning(deps, tenantInput());

    // 1. 事前確認
    let view = await advance(deps, SITE);
    assert.equal(view?.steps.preflight.status, "done");
    assert.equal(fakes.stripeState.customers.length, 0);

    // 2. Firebaseユーザー（パスワードなし）
    view = await advance(deps, SITE);
    const uid = view!.resources.ownerUid;
    const user = await adminAuth.getUser(uid);
    assert.equal(user.email, EMAIL);
    assert.equal(user.passwordHash, undefined);

    // 3. Stripe
    view = await advance(deps, SITE);
    assert.equal(view?.steps.stripe.status, "done");
    assert.equal(fakes.stripeState.customers.length, 1);
    assert.equal(view?.resources.stripeSubscriptionId, null);
    const stripeKeys = fakes.calls
      .filter((call) => /stripe\.\w+\.create/.test(call.op))
      .map((call) => (call.detail as any).idempotencyKey);
    assert.equal(stripeKeys.length, 1);
    assert.ok(stripeKeys[0].includes(view!.provisioningId));

    // 4. Firestore
    view = await advance(deps, SITE);
    const settings = (await adminDb.doc(`siteSettings/${SITE}`).get()).data()!;
    assert.equal(settings.ownerId, uid);
    assert.equal(settings.stripeCustomerId, view!.resources.stripeCustomerId);
    assert.equal(settings.stripeSubscriptionId, undefined);
    assert.equal(settings.isFreePlan, false);
    assert.deepEqual(settings.industry, { key: "food", name: "飲食" });
    assert.ok((await adminDb.doc(`siteSettingsEditable/${SITE}`).get()).exists);
    const profile = (await adminDb.doc(`sitePublicProfile/${SITE}`).get()).data()!;
    assert.equal(profile.siteName, "さくらベーカリー");
    assert.equal(profile.isFreePlan, false);
    assert.ok(!("ownerEmail" in profile));
    const site = (await adminDb.doc(`sites/${SITE}`).get()).data()!;
    assert.equal(site.productionUrl, `https://${DOMAIN}`);
    assert.equal(site.brand.name, "さくらベーカリー");
    for (const host of [DOMAIN, `www.${DOMAIN}`]) {
      const domainDoc = (await adminDb.doc(`domains/${host}`).get()).data()!;
      assert.equal(domainDoc.siteKey, SITE);
      assert.equal(domainDoc.canonicalHost, DOMAIN);
      assert.equal(domainDoc.domainStatus, "pending_dns");
    }

    // 5. Vercelプロジェクト
    view = await advance(deps, SITE);
    const project = fakes.vercelState.projects[0];
    assert.equal(project.name, `pageit-${SITE}`);
    assert.equal(project.link.org, "tsuyoshi-3110");
    assert.equal(project.link.repo, "pageit-platform");
    assert.equal(project.link.productionBranch, "store-main");
    assert.equal(project.envs.get("PAGEIT_SITE_KEY")?.value, SITE);
    assert.equal(project.envs.get("VERCEL_PROJECT_ID")?.value, project.id);
    assert.deepEqual(project.sharedEnvIds, ["env_shared_a", "env_shared_b"]);
    assert.match(project.ignoreCommand ?? "", /store-main/);
    assert.equal(view?.resources.vercelProjectId, project.id);

    // 6. ドメイン
    view = await advance(deps, SITE);
    assert.equal(project.domains.get(DOMAIN)?.redirect, undefined);
    assert.equal(project.domains.get(`www.${DOMAIN}`)?.redirect, DOMAIN);

    // 7. デプロイ（完了まで確認）
    fakes.vercelState.pollsUntilReady = 2;
    view = await advance(deps, SITE);
    assert.equal(view?.status, "waiting");
    assert.equal(view?.steps.deployment.status, "waiting");
    assert.ok(view?.retryAfterMs);
    assert.equal(fakes.vercelState.deployments[0].ref, "store-main");
    assert.equal(fakes.vercelState.deployments[0].target, "production");
    view = await advance(deps, SITE);
    assert.equal(view?.steps.deployment.status, "done");
    assert.equal(fakes.vercelState.deployments.length, 1);

    // 8. DNS（値を表示し、未反映なら待つ。公開前に案内メールは送らない）
    view = await advance(deps, SITE);
    assert.equal(view?.status, "waiting");
    assert.equal(view?.retryAfterMs, null);
    const apex = view?.resources.dns?.hosts.find((item) => item.host === DOMAIN);
    const www = view?.resources.dns?.hosts.find((item) => item.host === `www.${DOMAIN}`);
    assert.deepEqual(apex?.records[0], { type: "A", name: "@", value: "76.76.21.241" });
    assert.deepEqual(www?.records[0], { type: "CNAME", name: "www", value: "fake.vercel-dns-017.com." });
    assert.equal(fakes.mails.length, 0);

    view = await advance(deps, SITE); // 再確認しても未反映のまま
    assert.equal(view?.status, "waiting");
    fakes.vercelState.dnsReady = true;
    view = await advance(deps, SITE);
    assert.equal(view?.steps.dns.status, "done");
    assert.equal((await adminDb.doc(`sites/${SITE}`).get()).get("domainStatus"), "active");
    assert.equal((await adminDb.doc(`domains/${DOMAIN}`).get()).get("domainStatus"), "active");

    // 9. 案内メール（パスワード設定リンクつき、パスワードは含まない）
    view = await advance(deps, SITE);
    assert.equal(view?.status, "completed");
    assert.equal(fakes.mails.length, 1);
    assert.equal(fakes.mails[0].to, EMAIL);
    assert.match(fakes.mails[0].html, /oobCode=/);
    assert.match(fakes.mails[0].html, /mode=resetPassword/);
    // 有料プランは、支払うまで表示されないことと支払い方を案内する
    assert.match(fakes.mails[0].subject, /お支払いのお願い/);
    assert.match(fakes.mails[0].html, /サブスク支払いへ進む/);
    assert.doesNotMatch(fakes.mails[0].html, /公開しました/);

    // 完了後に呼んでも何も起きない
    view = await advance(deps, SITE);
    assert.equal(view?.status, "completed");
    assert.equal(fakes.mails.length, 1);
  });

  test("無料プラン: Stripeを省略する", async () => {
    await startProvisioning(deps, tenantInput({ plan: "free", wwwEnabled: false }));
    const view = await runToCompletion();
    assert.equal(view.status, "completed");
    assert.equal(view.steps.stripe.status, "skipped");
    assert.equal(fakes.calls.filter((call) => call.op.startsWith("stripe.")).length, 0);
    const settings = (await adminDb.doc(`siteSettings/${SITE}`).get()).data()!;
    assert.equal(settings.isFreePlan, true);
    assert.ok(!("stripeCustomerId" in settings));
    const profile = (await adminDb.doc(`sitePublicProfile/${SITE}`).get()).data()!;
    assert.equal(profile.isFreePlan, true);
    assert.ok(!(await adminDb.doc(`domains/www.${DOMAIN}`).get()).exists);
  });

  test("copyモード: 指定した値だけ暗号化して複製する", async () => {
    fakes.env.PROVISION_VERCEL_ENV_MODE = "copy";
    fakes.env.PROVISION_VERCEL_COPY_ENV_KEYS = "FIREBASE_PROJECT_ID,NEXT_PUBLIC_X";
    fakes.env.FIREBASE_PROJECT_ID = "copied-value";
    fakes.env.NEXT_PUBLIC_X = "public-value";
    deps = fakes.deps(adminDb, adminAuth);
    await startProvisioning(deps, tenantInput({ plan: "free" }));
    await runStepsThrough("vercelProject");
    const project = fakes.vercelState.projects[0];
    assert.equal(project.envs.get("FIREBASE_PROJECT_ID")?.type, "encrypted");
    assert.equal(project.envs.get("NEXT_PUBLIC_X")?.type, "plain");
    assert.deepEqual(project.sharedEnvIds, []);
  });

  test("設定不足なら事前確認で止まり、何も作らない", async () => {
    fakes.configProblems = ["VERCEL_TOKEN が未設定です"];
    await startProvisioning(deps, tenantInput());
    const view = await runUntilStop();
    assert.equal(view.status, "failed");
    assert.equal(view.steps.preflight.error?.code, "config-missing");
    assert.equal(view.steps.ownerUser.status, "pending");
    assert.equal(fakes.stripeState.customers.length, 0);
  });
});

describe("途中失敗からの再開", () => {
  for (const op of [
    "stripe.customers.create",
    "vercel.createProject",
    "vercel.upsertEnv",
    "vercel.linkSharedEnv",
    "vercel.setProductionBranch",
    "vercel.addProjectDomain",
    "vercel.createDeployment",
    "mail.send",
  ]) {
    test(`${op} の失敗で止まり、再開すると重複なく完了する`, async () => {
      fakes.failOnce(op);
      fakes.vercelState.dnsReady = true;
      await startProvisioning(deps, tenantInput());

      const stopped = await runPastDeployment();
      assert.equal(stopped.status, "failed");
      const failedSteps = Object.values(stopped.steps).filter((step) => step.status === "failed");
      assert.equal(failedSteps.length, 1);
      assert.match(failedSteps[0].error?.message ?? "", /模擬エラー/);

      // 再開を指示するまで進まない（失敗しても削除もしない）
      const callCount = fakes.calls.length;
      const idle = await advance(deps, SITE);
      assert.equal(idle?.status, "failed");
      assert.equal(fakes.calls.length, callCount);

      const done = await runPastDeployment({ resume: true });
      assert.equal(done.status, "completed");
      assert.equal(fakes.stripeState.customers.length, 1);
      assert.equal(fakes.vercelState.projects.length, 1);
      assert.equal(fakes.vercelState.deployments.length, 1);
      assert.equal(fakes.mails.length, 1);
      assert.equal((await adminAuth.listUsers()).users.length, 1);
    });
  }

  test("作成済みで記録前に落ちても、作り直さない（全手順）", async () => {
    fakes.vercelState.dnsReady = true;
    await startProvisioning(deps, tenantInput());
    const first = await runToCompletionWithoutMail();
    const { ownerUid } = first.resources;

    // ユーザー
    await forgetStep("ownerUser");
    await advance(deps, SITE);
    assert.equal((await adminAuth.listUsers()).users.length, 1);
    assert.equal((await adminAuth.getUserByEmail(EMAIL)).uid, ownerUid);

    // Stripe（idempotencyKey の期限後を想定して、検索で再利用できること）
    const createsBefore = opCount("stripe.customers.create");
    await forgetStep("stripe", { stripeCustomerId: null, stripeSubscriptionId: null });
    fakes.stripeState.idempotency.clear();
    const stripeView = await advance(deps, SITE);
    assert.equal(fakes.stripeState.customers.length, 1);
    assert.equal(opCount("stripe.customers.create"), createsBefore);
    assert.equal(stripeView?.resources.stripeCustomerId, "cus_fake1");

    // Firestore
    await forgetStep("firestore");
    const firestoreView = await advance(deps, SITE);
    assert.equal(firestoreView?.steps.firestore.status, "done");

    // Vercelプロジェクト（自分の記録があるものだけ引き継ぐ）
    await forgetStep("vercelProject", { vercelProjectId: null });
    const projectView = await advance(deps, SITE);
    assert.equal(projectView?.steps.vercelProject.status, "done");
    assert.equal(fakes.vercelState.projects.length, 1);

    // ドメイン
    await forgetStep("vercelDomain");
    const domainView = await advance(deps, SITE);
    assert.equal(domainView?.steps.vercelDomain.status, "done");

    // デプロイ（進行中または完了済みを引き継ぐ）
    await forgetStep("deployment", { deployment: null });
    const deployView = await advance(deps, SITE);
    assert.equal(deployView?.steps.deployment.status, "done");
    assert.equal(fakes.vercelState.deployments.length, 1);
  });

  async function runToCompletionWithoutMail() {
    await runStepsThrough("preflight");
    return runStepsThrough("deployment");
  }

  test("デプロイ失敗は理由を出して止まり、再開で新しいデプロイを始める", async () => {
    fakes.vercelState.nextDeployResult = "ERROR";
    await startProvisioning(deps, tenantInput());
    const stopped = await runPastDeployment();
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.steps.deployment.error?.code, "deployment-failed");
    assert.match(stopped.steps.deployment.error?.message ?? "", /vercel\.example/);

    fakes.vercelState.nextDeployResult = "READY";
    fakes.vercelState.deployments[0].state = "ERROR";
    const resumed = await runPastDeployment({ resume: true });
    assert.equal(resumed.steps.deployment.status, "done");
    assert.equal(fakes.vercelState.deployments.length, 2);
  });

  test("メール送信中に落ちたら二重送信せず、管理者の再送指示で送る", async () => {
    await startProvisioning(deps, tenantInput());
    fakes.vercelState.dnsReady = true;
    await runStepsThrough("dns");
    await runDoc().update({
      "resources.mail.attemptedAt": new Date().toISOString(),
    });

    const stopped = await advance(deps, SITE);
    assert.equal(stopped?.status, "failed");
    assert.equal(stopped?.steps.ownerMail.error?.code, "mail-outcome-unknown");
    assert.equal(fakes.mails.length, 0);
    assert.equal(stopped?.canResendMail, true);

    const retried = await advance(deps, SITE, { resume: true });
    assert.equal(retried?.status, "failed");
    assert.equal(fakes.mails.length, 0);

    const resent = await advance(deps, SITE, { resendMail: true });
    assert.equal(resent?.status, "completed");
    assert.equal(fakes.mails.length, 1);
  });

  test("完了後の再送は明示したときだけ送る", async () => {
    await startProvisioning(deps, tenantInput());
    await runToCompletion();
    assert.equal(fakes.mails.length, 1);
    const resent = await advance(deps, SITE, { resendMail: true });
    assert.equal(resent?.status, "completed");
    assert.equal(fakes.mails.length, 2);
  });

  test("画面を閉じた後でも記録から続けられる", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("firestore");
    const reopened = await getProvisioning(deps, SITE);
    assert.equal(reopened?.status, "in_progress");
    assert.equal(reopened?.steps.firestore.status, "done");
    assert.equal(reopened?.steps.vercelProject.status, "pending");

    deps = fakes.deps(adminDb, adminAuth); // 別のリクエスト相当
    fakes.vercelState.dnsReady = true;
    const done = await runPastDeployment({ resume: true });
    assert.equal(done.status, "completed");
  });

  test("同時に実行しても手順は1回だけ動く", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("ownerUser");
    const results = await Promise.all([advance(deps, SITE), advance(deps, SITE), advance(deps, SITE)]);
    assert.equal(fakes.stripeState.customers.length, 1);
    assert.equal(opCount("stripe.customers.create"), 1);
    assert.ok(results.some((view) => view?.steps.stripe.status === "done" || view?.busy));
    const run = await readRun();
    assert.equal(run.lock, null);
  });

  test("実行中のロックがあれば待たせ、期限切れなら引き継ぐ", async () => {
    await startProvisioning(deps, tenantInput());
    await runDoc().update({
      lock: { token: "other", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const busy = await advance(deps, SITE);
    assert.equal(busy?.busy, true);
    assert.equal(busy?.steps.preflight.status, "pending");

    await runDoc().update({
      lock: { token: "other", expiresAt: new Date(Date.now() - 1_000).toISOString() },
    });
    const taken = await advance(deps, SITE);
    assert.equal(taken?.steps.preflight.status, "done");
  });

  test("想定外のエラー文面から秘密情報を除く", async () => {
    fakes.failOnce("stripe.customers.create", "failed with sk_live_abc123 and Bearer token-xyz");
    await startProvisioning(deps, tenantInput());
    const stopped = await runUntilStop();
    const message = stopped.steps.stripe.error?.message ?? "";
    assert.ok(!message.includes("sk_live_abc123"));
    assert.ok(!message.includes("token-xyz"));
    const stored = JSON.stringify(await readRun());
    assert.ok(!stored.includes("sk_live_abc123"));
  });
});

describe("案内メールと店舗のアドレス", () => {
  test("無料プランは公開の案内のままで、支払いを求めない", async () => {
    await startProvisioning(deps, tenantInput({ plan: "free" }));
    await runToCompletion();
    assert.match(fakes.mails[0].subject, /公開しました/);
    assert.doesNotMatch(fakes.mails[0].html, /支払い/);
  });

  test("店舗のアドレスをプロジェクトの環境変数に入れる", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("vercelProject");
    const project = fakes.vercelState.projects[0];
    assert.equal(project.envs.get("NEXT_PUBLIC_APP_URL")?.value, `https://${DOMAIN}`);
  });
});

describe("DNS確認の応答がないとき", () => {
  async function runToDns() {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("deployment");
  }

  test("失敗にせず値を案内し、次の確認で完了できる", async () => {
    await runToDns();
    fakes.vercelState.domainConfigTimeouts = 2;
    let view = await advance(deps, SITE);
    assert.equal(view?.status, "waiting");
    assert.equal(view?.steps.dns.error, null);
    const hosts = view?.resources.dns?.hosts ?? [];
    assert.deepEqual(hosts.map((item) => item.host), [DOMAIN, `www.${DOMAIN}`]);
    assert.deepEqual(hosts[0].records[0], { type: "A", name: "@", value: "76.76.21.21" });
    assert.deepEqual(hosts[1].records[0], { type: "CNAME", name: "www", value: "cname.vercel-dns.com." });
    assert.ok(hosts.every((item) => item.misconfigured));

    fakes.vercelState.dnsReady = true;
    view = await advance(deps, SITE);
    assert.equal(view?.steps.dns.status, "done");
  });

  test("確認できない間は、反映済みでも完了にしない", async () => {
    await runToDns();
    fakes.vercelState.dnsReady = true;
    fakes.vercelState.domainConfigTimeouts = 1;
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "waiting");
    assert.equal(view?.steps.dns.status, "waiting");
    assert.equal(fakes.mails.length, 0);
    assert.equal((await adminDb.doc(`sites/${SITE}`).get()).get("domainStatus"), "pending_dns");
  });

  test("一度案内した値は、確認できない回も変えない", async () => {
    await runToDns();
    await advance(deps, SITE);
    fakes.vercelState.domainConfigTimeouts = 2;
    const view = await advance(deps, SITE);
    const hosts = view?.resources.dns?.hosts ?? [];
    assert.equal(hosts[0].records[0].value, "76.76.21.241");
    assert.equal(hosts[1].records[0].value, "fake.vercel-dns-017.com.");
  });

  test("Vercelの5xxも待ち状態にする", async () => {
    await runToDns();
    fakes.failOnce("vercel.getDomainConfig");
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "waiting");
    assert.equal(view?.steps.dns.error, null);
  });

  test("権限エラーは隠さず失敗として見せる", async () => {
    await runToDns();
    fakes.failOnce("vercel.getDomainConfig", "権限がありません", 403, "forbidden");
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "failed");
    assert.equal(view?.steps.dns.error?.code, "vercel-forbidden");
  });

  test("複数のドメインを同時に確認する", async () => {
    await runToDns();
    const original = deps.vercel.getDomainConfig;
    let active = 0;
    let peak = 0;
    deps = {
      ...deps,
      vercel: {
        ...deps.vercel,
        getDomainConfig: async (host: string, projectId: string) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return original(host, projectId);
        },
      },
    };
    await advance(deps, SITE);
    assert.equal(peak, 2);
  });

  test("DNS確認だけ長い時間制限で呼び出す", async () => {
    await runToDns();
    const realTimeout = AbortSignal.timeout;
    const limits: number[] = [];
    AbortSignal.timeout = (ms: number) => {
      limits.push(ms);
      return realTimeout.call(AbortSignal, ms);
    };
    try {
      await advance(deps, SITE);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    assert.ok(limits.includes(15_000));
    assert.equal(limits.filter((ms) => ms === 40_000).length, 2);
  });
});

describe("上書き拒否", () => {
  const blockers: [string, () => Promise<unknown>, string][] = [
    ["sites", () => adminDb.doc(`sites/${SITE}`).set({ keep: true }), "siteKey"],
    ["siteSettings", () => adminDb.doc(`siteSettings/${SITE}`).set({ keep: true }), "siteKey"],
    ["siteSettingsEditable", () => adminDb.doc(`siteSettingsEditable/${SITE}`).set({ keep: true }), "siteKey"],
    ["domains（wwwなし）", () => adminDb.doc(`domains/${DOMAIN}`).set({ siteKey: "other" }), "domain"],
    ["domains（www）", () => adminDb.doc(`domains/www.${DOMAIN}`).set({ siteKey: "other" }), "domain"],
    ["既存店舗の canonicalHost", () => adminDb.doc("sites/old").set({ canonicalHost: DOMAIN }), "domain"],
    ["既存店舗の productionUrl", () => adminDb.doc("sites/old").set({ productionUrl: `https://${DOMAIN}` }), "domain"],
    ["既存店舗の config.productionUrl", () => adminDb.doc("sites/old").set({ config: { productionUrl: `https://${DOMAIN}` } }), "domain"],
    ["Firebaseユーザー", () => adminAuth.createUser({ email: EMAIL }), "ownerEmail"],
    ["既存のオーナー", () => adminDb.doc("siteSettings/old").set({ ownerEmail: EMAIL }), "ownerEmail"],
  ];

  for (const [name, setup, field] of blockers) {
    test(`使用済みなら何も作らない: ${name}`, async () => {
      await setup();
      await assert.rejects(startProvisioning(deps, tenantInput()), (error) => {
        assert.ok(error instanceof ProvisioningConflictError);
        assert.ok(error.conflicts.some((item) => item.field === field));
        return true;
      });
      assert.equal((await runDoc().get()).exists, false);
      assert.equal(fakes.stripeState.customers.length, 0);
      assert.equal(fakes.vercelState.projects.length, 0);
    });
  }

  test("使用済み: Vercelプロジェクト名", async () => {
    await fakes.deps(adminDb, adminAuth).vercel.createProject({
      name: `pageit-${SITE}`,
      framework: "nextjs",
      gitRepository: { type: "github", repo: "other/repo" },
      environmentVariables: [],
      commandForIgnoringBuildStep: "",
    });
    await assert.rejects(startProvisioning(deps, tenantInput()), ProvisioningConflictError);
    assert.equal((await runDoc().get()).exists, false);
  });

  test("同じ店舗キー・ドメイン・メールの追加処理を重ねて始められない", async () => {
    await startProvisioning(deps, tenantInput());
    await assert.rejects(startProvisioning(deps, tenantInput()), (error: ProvisioningConflictError) => error.existingRun);
    await assert.rejects(
      startProvisioning(deps, tenantInput({ siteKey: "other-shop", ownerEmail: "b@example.com" })),
      ProvisioningConflictError
    );
    await assert.rejects(
      startProvisioning(deps, tenantInput({ siteKey: "other-shop", domain: "other.example" })),
      ProvisioningConflictError
    );
  });

  test("開始後に使われたら事前確認で止まり、後続を実行しない", async () => {
    await startProvisioning(deps, tenantInput());
    await adminDb.doc(`domains/${DOMAIN}`).set({ siteKey: "other" });
    const view = await runUntilStop();
    assert.equal(view.status, "failed");
    assert.equal(view.steps.preflight.error?.code, "already-used");
    assert.equal(view.steps.ownerUser.status, "pending");
    assert.equal((await adminAuth.listUsers()).users.length, 0);
    assert.equal((await adminDb.doc(`domains/${DOMAIN}`).get()).get("siteKey"), "other");
  });

  test("事前確認の後でメールが使われたら、そのユーザーを再利用しない", async () => {
    await startProvisioning(deps, tenantInput());
    await advance(deps, SITE);
    const other = await adminAuth.createUser({ email: EMAIL });
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "failed");
    assert.equal(view?.steps.ownerUser.error?.code, "owner-email-taken");
    assert.notEqual(view?.resources.ownerUid, other.uid);
    assert.equal(fakes.stripeState.customers.length, 0);
  });

  test("Firestoreの書き込み直前に使われたら、1件も書かず既存を変えない", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("stripe");
    await adminDb.doc(`domains/www.${DOMAIN}`).set({ siteKey: "other", keep: true });
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "failed");
    assert.equal(view?.steps.firestore.error?.code, "firestore-conflict");
    assert.equal((await adminDb.doc(`siteSettings/${SITE}`).get()).exists, false);
    assert.equal((await adminDb.doc(`sites/${SITE}`).get()).exists, false);
    assert.equal((await adminDb.doc(`domains/${DOMAIN}`).get()).exists, false);
    assert.equal((await adminDb.doc(`domains/www.${DOMAIN}`).get()).get("keep"), true);
    // 失敗しても作成済みのものは削除しない
    assert.equal((await adminAuth.listUsers()).users.length, 1);
    assert.equal(fakes.stripeState.customers.length, 1);
  });

  test("別の処理のsiteSettingsがあれば、自分のものとして扱わない", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("stripe");
    await adminDb.doc(`siteSettings/${SITE}`).set({ provisioningId: "someone-else" });
    const view = await advance(deps, SITE);
    assert.equal(view?.steps.firestore.error?.code, "firestore-conflict");
    assert.equal((await adminDb.doc(`siteSettings/${SITE}`).get()).get("provisioningId"), "someone-else");
  });

  test("今回作っていないVercelプロジェクトは変更しない", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("firestore");
    await deps.vercel.createProject({
      name: `pageit-${SITE}`,
      framework: "nextjs",
      gitRepository: { type: "github", repo: "other/repo" },
      environmentVariables: [{ key: "PAGEIT_PROVISIONING_ID", value: "someone-else", type: "plain", target: ["production"] }],
      commandForIgnoringBuildStep: "",
    });
    const view = await advance(deps, SITE);
    assert.equal(view?.steps.vercelProject.error?.code, "vercel-project-conflict");
    assert.equal(fakes.vercelState.projects[0].envs.has("PAGEIT_SITE_KEY"), false);
  });

  test("他のVercelプロジェクトで使用中のドメインは奪わず止まる", async () => {
    await startProvisioning(deps, tenantInput());
    await runStepsThrough("vercelProject");
    const other = await deps.vercel.createProject({
      name: "pageit-other",
      framework: "nextjs",
      gitRepository: { type: "github", repo: "other/repo" },
      environmentVariables: [],
      commandForIgnoringBuildStep: "",
    });
    await deps.vercel.addProjectDomain(other.id, { name: DOMAIN });
    const view = await advance(deps, SITE);
    assert.equal(view?.status, "failed");
    assert.equal(view?.steps.vercelDomain.error?.code, "vercel-domain-conflict");
  });

  test("本番ブランチを確認できなければデプロイへ進まない", async () => {
    fakes.vercelState.branchApiIgnored = true;
    await startProvisioning(deps, tenantInput());
    const view = await runUntilStop();
    assert.equal(view.status, "failed");
    assert.equal(view.steps.vercelProject.error?.code, "vercel-branch-not-set");
    assert.equal(view.steps.deployment.status, "pending");
    assert.equal(fakes.vercelState.deployments.length, 0);
  });
});

describe("記録の破棄", () => {
  test("何も作っていない記録だけ破棄できる", async () => {
    await startProvisioning(deps, tenantInput());
    assert.equal(await discardProvisioning(deps, SITE), "deleted");
    assert.equal(await discardProvisioning(deps, SITE), "not-found");

    await startProvisioning(deps, tenantInput());
    await runStepsThrough("preflight");
    assert.equal(await discardProvisioning(deps, SITE), "not-discardable");
    assert.equal((await runDoc().get()).exists, true);
  });
});
