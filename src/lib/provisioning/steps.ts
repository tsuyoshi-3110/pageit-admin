import { FieldValue } from "firebase-admin/firestore";
import { buildInitialSiteDocument } from "../tenantDocs";
import { STORE_GIT_BRANCH, STORE_GIT_ORG, STORE_GIT_REPO } from "./config";
import type { ProvisioningDeps } from "./deps";
import { hostsOf, projectNameOf } from "./input";
import { findConflicts } from "./preflight";
import type { DnsHostStatus, DnsRecord, ProvisioningRun, Resources, StepId } from "./types";
import { isVercelApiError, type VercelDomainConfig, type VercelEnvVar } from "./vercel-client";

/** 手順を止める失敗です。message はそのまま画面に出します。 */
export class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

export type StepResult =
  | { kind: "done" }
  | { kind: "skipped" }
  /** 待ち状態。retryAfterMs があれば画面が自動で再実行し、null なら操作を待ちます。 */
  | { kind: "waiting"; retryAfterMs: number | null };

export type StepContext = {
  deps: ProvisioningDeps;
  run: ProvisioningRun;
  /** 外部に作ったものの情報をすぐ保存します。途中で落ちても再開時に二重に作りません。 */
  saveResources: (patch: Partial<Resources>) => Promise<void>;
};

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

async function preflight({ deps, run }: StepContext): Promise<StepResult> {
  const problems = deps.findConfigProblems(run.input.plan);
  if (problems.length > 0) {
    throw new StepFailure("config-missing", `設定が足りません: ${problems.join(" / ")}`);
  }
  const conflicts = await findConflicts(deps, run.input, run.siteKey);
  if (conflicts.length > 0) {
    throw new StepFailure("already-used", conflicts.map((item) => item.message).join(" "));
  }
  return { kind: "done" };
}

async function ownerUser({ deps, run }: StepContext): Promise<StepResult> {
  const uid = run.resources.ownerUid;
  const email = run.input.ownerEmail;

  const reuseOwn = async () => {
    const user = await deps.auth.getUser(uid);
    if (user.email?.toLowerCase() !== email) {
      throw new StepFailure(
        "owner-user-mismatch",
        `ユーザー ${uid} のメールアドレスが入力と異なるため、再利用しませんでした。`
      );
    }
  };

  try {
    await reuseOwn();
    return { kind: "done" };
  } catch (error) {
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }

  try {
    // パスワードは設定しません。オーナーが案内メールのリンクから自分で設定します。
    await deps.auth.createUser({ uid, email, emailVerified: false, displayName: run.input.siteName });
  } catch (error) {
    if (errorCode(error) === "auth/email-already-exists") {
      throw new StepFailure(
        "owner-email-taken",
        `メールアドレス「${email}」は別のユーザーが使用中です。既存のユーザーは再利用しません。`
      );
    }
    if (errorCode(error) !== "auth/uid-already-exists") throw error;
    await reuseOwn();
  }
  return { kind: "done" };
}

async function stripe({ deps, run, saveResources }: StepContext): Promise<StepResult> {
  if (run.input.plan === "free") return { kind: "skipped" };

  const client = await deps.getStripe();
  const { provisioningId, siteKey, input } = run;
  const metadata = {
    provisioningId,
    siteKey,
    siteName: input.siteName,
    industryKey: input.industry.key,
    industryName: input.industry.name,
  };

  // Stripeの idempotencyKey は期限があるため、時間が空いた再開に備えて既存分も探します。
  let customerId = run.resources.stripeCustomerId;
  if (!customerId) {
    const existing = await client.customers.list({ email: input.ownerEmail, limit: 100 });
    customerId =
      existing.data.find((item) => item.metadata?.provisioningId === provisioningId)?.id ??
      (
        await client.customers.create(
          { email: input.ownerEmail, name: input.siteName, metadata },
          { idempotencyKey: `pageit-provision-${provisioningId}-customer` }
        )
      ).id;
    await saveResources({ stripeCustomerId: customerId });
  }

  if (!run.resources.stripeSubscriptionId) {
    const priceId = deps.config.stripePriceId;
    if (!priceId) throw new StepFailure("config-missing", "STRIPE_DEFAULT_PRICE_ID が未設定です。");
    const existing = await client.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    const subscriptionId =
      existing.data.find((item) => item.metadata?.provisioningId === provisioningId)?.id ??
      (
        await client.subscriptions.create(
          {
            customer: customerId,
            items: [{ price: priceId }],
            // 既存の /api/stripe/create-stripe-customer と同じ支払い方式です
            payment_behavior: "default_incomplete",
            metadata,
          },
          { idempotencyKey: `pageit-provision-${provisioningId}-subscription` }
        )
      ).id;
    await saveResources({ stripeSubscriptionId: subscriptionId });
  }
  return { kind: "done" };
}

async function firestore({ deps, run }: StepContext): Promise<StepResult> {
  const { db } = deps;
  const { siteKey, input, provisioningId, resources } = run;
  const now = FieldValue.serverTimestamp();
  const productionUrl = `https://${input.domain}`;
  const domainFields = {
    siteKey,
    canonicalHost: input.domain,
    domain: input.domain,
    wwwEnabled: input.wwwEnabled,
    domainStatus: "pending_dns",
  };

  // create は既存のドキュメントがあると失敗します。1件でも使用済みなら全件書き込まれません。
  const batch = db.batch();
  batch.create(db.doc(`siteSettings/${siteKey}`), {
    provisioningId,
    ownerId: resources.ownerUid,
    siteName: input.siteName,
    siteKey,
    ownerName: "",
    ownerAddress: "",
    ownerPhone: "",
    ownerEmail: input.ownerEmail,
    homepageUrl: productionUrl,
    isFreePlan: input.plan === "free",
    setupMode: false,
    industry: input.industry,
    ...(resources.stripeCustomerId ? { stripeCustomerId: resources.stripeCustomerId } : {}),
    ...(resources.stripeSubscriptionId
      ? { stripeSubscriptionId: resources.stripeSubscriptionId }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
  batch.create(db.doc(`siteSettingsEditable/${siteKey}`), { siteKey, createdAt: now });
  batch.create(db.doc(`sites/${siteKey}`), {
    ...buildInitialSiteDocument({
      siteKey,
      siteName: input.siteName,
      productionUrl,
      businessCategory: input.industry.name,
    }),
    ...domainFields,
    createdAt: now,
  });
  for (const host of hostsOf(input)) {
    batch.create(db.doc(`domains/${host}`), { ...domainFields, createdAt: now });
  }

  try {
    await batch.commit();
    return { kind: "done" };
  } catch (error) {
    // 6 = ALREADY_EXISTS
    if ((error as { code?: number })?.code !== 6) throw error;
  }

  // 前回の実行で書き込み済みなら完了扱いにします。それ以外は上書きせず止めます。
  const settings = await db.doc(`siteSettings/${siteKey}`).get();
  if (settings.exists && settings.get("provisioningId") === provisioningId) {
    return { kind: "done" };
  }
  throw new StepFailure(
    "firestore-conflict",
    "店舗キーまたはドメインのドキュメントが別の処理で作成されたため、上書きせず停止しました。"
  );
}

function storeEnvVars(run: ProvisioningRun, projectId: string | null, deps: ProvisioningDeps) {
  const target = ["production", "preview"];
  const plain = (key: string, value: string): VercelEnvVar => ({ key, value, type: "plain", target });
  const vars = [
    plain("PAGEIT_SITE_KEY", run.siteKey),
    // 再開時に、このプロジェクトが今回の処理で作ったものか確かめるために使います
    plain("PAGEIT_PROVISIONING_ID", run.provisioningId),
  ];
  if (projectId) vars.push(plain("VERCEL_PROJECT_ID", projectId));
  if (deps.config.envMode === "copy") {
    for (const key of deps.config.copyEnvKeys) {
      vars.push({
        key,
        value: deps.config.env[key] ?? "",
        type: key.startsWith("NEXT_PUBLIC_") ? "plain" : "encrypted",
        target,
      });
    }
  }
  return vars;
}

async function vercelProject({ deps, run, saveResources }: StepContext): Promise<StepResult> {
  const { vercel, config } = deps;
  const name = projectNameOf(run.siteKey);
  let projectId = run.resources.vercelProjectId;

  if (!projectId) {
    const adoptExisting = async () => {
      const existing = await vercel.getProject(name);
      if (!existing) return null;
      const envs = await vercel.listEnv(existing.id);
      const own = envs.some(
        (item) => item.key === "PAGEIT_PROVISIONING_ID" && item.value === run.provisioningId
      );
      if (!own) {
        throw new StepFailure(
          "vercel-project-conflict",
          `Vercelプロジェクト「${name}」は今回の処理で作ったものではないため、変更せず停止しました。`
        );
      }
      return existing;
    };

    let project = await adoptExisting();
    if (!project) {
      try {
        project = await vercel.createProject({
          name,
          framework: "nextjs",
          gitRepository: { type: "github", repo: `${STORE_GIT_ORG}/${STORE_GIT_REPO}` },
          environmentVariables: storeEnvVars(run, null, deps),
          // store-main 以外へのプッシュでは、この店舗のビルドを動かしません
          commandForIgnoringBuildStep: `[ "$VERCEL_GIT_COMMIT_REF" != "${STORE_GIT_BRANCH}" ]`,
        });
      } catch (error) {
        if (!isVercelApiError(error) || error.status !== 409) throw error;
        project = await adoptExisting();
        if (!project) throw error;
      }
    }
    projectId = project.id;
    await saveResources({ vercelProjectId: projectId });
  }

  await vercel.upsertEnv(projectId, storeEnvVars(run, projectId, deps));
  if (config.envMode === "shared") {
    await vercel.linkSharedEnv(config.sharedEnvIds, projectId);
  }

  await vercel.setProductionBranch(projectId, STORE_GIT_BRANCH);
  const project = await vercel.getProject(projectId);
  const branch = project?.link?.productionBranch;
  if (branch !== STORE_GIT_BRANCH) {
    // 既定ブランチのままデプロイへ進むと、別のコードが公開されるおそれがあるため止めます
    throw new StepFailure(
      "vercel-branch-not-set",
      `本番ブランチを ${STORE_GIT_BRANCH} に設定できませんでした（現在: ${branch ?? "不明"}）。Vercelの画面で確認してください。`
    );
  }
  return { kind: "done" };
}

function requireProjectId(run: ProvisioningRun) {
  const id = run.resources.vercelProjectId;
  if (!id) throw new StepFailure("vercel-project-missing", "VercelプロジェクトのIDが記録されていません。");
  return id;
}

async function vercelDomain({ deps, run }: StepContext): Promise<StepResult> {
  const projectId = requireProjectId(run);
  const { domain } = run.input;

  for (const host of hostsOf(run.input)) {
    if (await deps.vercel.getProjectDomain(projectId, host)) continue;
    try {
      await deps.vercel.addProjectDomain(projectId, {
        name: host,
        // 検索順位が分散しないよう、www は www なしへ転送します
        ...(host === domain ? {} : { redirect: domain, redirectStatusCode: 308 }),
      });
    } catch (error) {
      if (isVercelApiError(error) && error.status === 409) {
        throw new StepFailure(
          "vercel-domain-conflict",
          `ドメイン「${host}」は別のVercelプロジェクトで使用中か、追加できません: ${error.message}`
        );
      }
      throw error;
    }
  }
  return { kind: "done" };
}

const DEPLOY_POLL_MS = 10_000;
const ACTIVE_DEPLOY_STATES = ["QUEUED", "INITIALIZING", "BUILDING", "READY"];

async function deployment({ deps, run, saveResources }: StepContext): Promise<StepResult> {
  const { vercel } = deps;
  const projectId = requireProjectId(run);
  let current = run.resources.deployment;

  if (!current) {
    // 前回の開始直後に落ちた場合に備え、進行中のデプロイがあれば引き継ぎます
    const existing = (await vercel.listProductionDeployments(projectId)).find(
      (item) => item.ref === STORE_GIT_BRANCH && ACTIVE_DEPLOY_STATES.includes(item.state)
    );
    const started =
      existing ??
      (await vercel.createDeployment({
        name: projectNameOf(run.siteKey),
        project: projectId,
        target: "production",
        gitSource: {
          type: "github",
          org: STORE_GIT_ORG,
          repo: STORE_GIT_REPO,
          ref: STORE_GIT_BRANCH,
        },
      }));
    current = {
      id: started.id,
      url: started.url,
      state: started.state,
      inspectorUrl: started.inspectorUrl,
    };
    await saveResources({ deployment: current });
  }

  const latest = await vercel.getDeployment(current.id);
  const snapshot = {
    id: latest.id,
    url: latest.url,
    state: latest.state,
    inspectorUrl: latest.inspectorUrl ?? current.inspectorUrl,
  };

  if (latest.state === "READY") {
    await saveResources({ deployment: snapshot });
    return { kind: "done" };
  }
  if (latest.state === "ERROR" || latest.state === "CANCELED") {
    // 記録を消すと、再開時に新しいデプロイを開始します
    await saveResources({ deployment: null });
    throw new StepFailure(
      "deployment-failed",
      `デプロイが失敗しました（${latest.state}）。${snapshot.inspectorUrl ? `ログ: ${snapshot.inspectorUrl}` : ""}`.trim()
    );
  }
  await saveResources({ deployment: snapshot });
  return { kind: "waiting", retryAfterMs: DEPLOY_POLL_MS };
}

const FALLBACK_IPV4 = "76.76.21.21";
const FALLBACK_CNAME = "cname.vercel-dns.com.";

function firstRanked<T extends { rank: number }>(items: T[] | undefined) {
  return [...(items ?? [])].sort((a, b) => a.rank - b.rank)[0];
}

/** Vercel側の一時的な不調（応答なし・接続失敗・5xx）かどうかを判定します。権限エラーなどは含めません。 */
function isTemporaryVercelError(error: unknown) {
  return isVercelApiError(error) && (error.status === 0 || error.status >= 500);
}

async function checkDnsHost(
  { deps, run }: Pick<StepContext, "deps" | "run">,
  projectId: string,
  host: string
): Promise<DnsHostStatus> {
  const { vercel } = deps;
  let domain = await vercel.getProjectDomain(projectId, host);
  if (!domain) {
    throw new StepFailure("vercel-domain-missing", `ドメイン「${host}」がVercelプロジェクトにありません。`);
  }
  if (!domain.verified) {
    try {
      domain = await vercel.verifyProjectDomain(projectId, host);
    } catch (error) {
      // 未反映のときは 400 が返ります。待ち状態として扱います。
      if (!isVercelApiError(error) || error.status !== 400) throw error;
    }
  }

  // 確認できないときも設定する値は案内できるため、止めずに「未反映」として扱います。
  let config: VercelDomainConfig | null = null;
  try {
    config = await vercel.getDomainConfig(host, projectId);
  } catch (error) {
    if (!isTemporaryVercelError(error)) throw error;
    console.warn(`[provisioning] ${run.siteKey} DNS確認を次回に持ち越します: ${host}`);
  }

  const isApex = domain.apexName === host;
  const type = isApex ? "A" : "CNAME";
  // 確認できなかった回に表示の値が変わらないよう、前回の値を優先します
  const previous = run.resources.dns?.hosts
    .find((item) => item.host === host)
    ?.records.find((record) => record.type === type)?.value;
  const records: DnsRecord[] = isApex
    ? [{
        type,
        name: "@",
        value: firstRanked(config?.recommendedIPv4)?.value?.[0] ?? previous ?? FALLBACK_IPV4,
      }]
    : [{
        type,
        name: host.slice(0, -(domain.apexName.length + 1)),
        value: firstRanked(config?.recommendedCNAME)?.value ?? previous ?? FALLBACK_CNAME,
      }];
  if (!domain.verified) {
    for (const challenge of domain.verification ?? []) {
      records.push({ type: challenge.type, name: challenge.domain, value: challenge.value });
    }
  }
  return {
    host,
    verified: domain.verified,
    // 確認できなかった場合は反映済みにしません
    misconfigured: config?.misconfigured ?? true,
    records,
  };
}

async function dns({ deps, run, saveResources }: StepContext): Promise<StepResult> {
  const projectId = requireProjectId(run);
  // 確認に20秒ほどかかるため、関数の上限に収まるよう同時に調べます
  const hosts = await Promise.all(
    hostsOf(run.input).map((host) => checkDnsHost({ deps, run }, projectId, host))
  );

  await saveResources({ dns: { checkedAt: deps.now().toISOString(), hosts } });
  const ready = hosts.every((item) => item.verified && !item.misconfigured);
  if (!ready) return { kind: "waiting", retryAfterMs: null };

  // 店舗側のドメイン設定画面に出す状態を更新します（既存の他の項目は変えません）
  const batch = deps.db.batch();
  for (const path of [
    `sites/${run.siteKey}`,
    ...hostsOf(run.input).map((host) => `domains/${host}`),
  ]) {
    batch.update(deps.db.doc(path), { domainStatus: "active" });
  }
  await batch.commit();
  return { kind: "done" };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ownerMailHtml(run: ProvisioningRun, passwordLink: string) {
  const siteUrl = `https://${run.input.domain}`;
  const name = escapeHtml(run.input.siteName);
  const email = escapeHtml(run.input.ownerEmail);
  return `
    <p>${name} のホームページを公開しました。</p>
    <p>公開先: <a href="${siteUrl}">${siteUrl}</a></p>
    <p>はじめに、次のリンクからパスワードを設定してください。リンクには有効期限があります。期限が切れた場合は運営までご連絡ください。</p>
    <p><a href="${escapeHtml(passwordLink)}">パスワードを設定する</a></p>
    <p>ログイン画面: <a href="${siteUrl}/login">${siteUrl}/login</a><br>ログインID: ${email}</p>
  `;
}

async function ownerMail({ deps, run, saveResources }: StepContext): Promise<StepResult> {
  const { mail } = run.resources;
  if (mail.sentAt) return { kind: "done" };
  if (mail.attemptedAt) {
    // 送信中に処理が落ちると、届いたか判断できません。二重送信を避けて確認を求めます。
    throw new StepFailure(
      "mail-outcome-unknown",
      "前回の送信結果が確認できませんでした。オーナーに届いていないことを確認してから「案内メールを再送」を押してください。"
    );
  }

  const link = await deps.auth.generatePasswordResetLink(run.input.ownerEmail);
  await saveResources({ mail: { attemptedAt: deps.now().toISOString(), sentAt: null } });
  try {
    await deps.sendMail(
      run.input.ownerEmail,
      `【Pageit】${run.input.siteName} のホームページを公開しました`,
      ownerMailHtml(run, link)
    );
  } catch (error) {
    await saveResources({ mail: { attemptedAt: null, sentAt: null } });
    throw error;
  }
  await saveResources({
    mail: { attemptedAt: run.resources.mail.attemptedAt, sentAt: deps.now().toISOString() },
  });
  return { kind: "done" };
}

export const STEP_HANDLERS: Record<StepId, (context: StepContext) => Promise<StepResult>> = {
  preflight,
  ownerUser,
  stripe,
  firestore,
  vercelProject,
  vercelDomain,
  deployment,
  dns,
  ownerMail,
};
