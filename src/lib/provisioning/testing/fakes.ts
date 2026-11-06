import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { readConfig } from "../config";
import type { ProvisioningDeps, StripePort } from "../deps";
import { createVercelClient } from "../vercel-client";

/** テストとローカル検証で使う、外部サービスの偽物です。ネットワークには出ません。 */

type Call = { op: string; detail?: unknown };

export function createFakes() {
  const calls: Call[] = [];
  const failures = new Map<string, { status?: number; code?: string; message: string }>();

  /** 次回の op だけ失敗させます */
  const failOnce = (op: string, message = `${op} の模擬エラー`, status = 500, code = "fake_error") =>
    failures.set(op, { status, code, message });
  const hit = (op: string, detail?: unknown) => {
    calls.push({ op, detail });
    const failure = failures.get(op);
    if (failure) {
      failures.delete(op);
      return failure;
    }
    return null;
  };

  // ---- Stripe ----
  const stripeState = {
    customers: [] as { id: string; email?: string; metadata: Record<string, string> }[],
    subscriptions: [] as { id: string; customer: string; metadata: Record<string, string> }[],
    idempotency: new Map<string, string>(),
  };
  const stripeOp = (op: string, detail?: unknown) => {
    const failure = hit(op, detail);
    if (failure) throw new Error(failure.message);
  };
  const stripe: StripePort = {
    customers: {
      async list(params) {
        stripeOp("stripe.customers.list");
        return { data: stripeState.customers.filter((c) => c.email === params.email) as any };
      },
      async create(params, { idempotencyKey }) {
        stripeOp("stripe.customers.create", { idempotencyKey });
        const known = stripeState.idempotency.get(idempotencyKey);
        if (known) return { id: known };
        const id = `cus_fake${stripeState.customers.length + 1}`;
        stripeState.customers.push({
          id,
          email: params.email,
          metadata: (params.metadata ?? {}) as Record<string, string>,
        });
        stripeState.idempotency.set(idempotencyKey, id);
        return { id };
      },
    },
    subscriptions: {
      async list(params) {
        stripeOp("stripe.subscriptions.list");
        return { data: stripeState.subscriptions.filter((s) => s.customer === params.customer) as any };
      },
      async create(params, { idempotencyKey }) {
        stripeOp("stripe.subscriptions.create", { idempotencyKey });
        const known = stripeState.idempotency.get(idempotencyKey);
        if (known) return { id: known };
        const id = `sub_fake${stripeState.subscriptions.length + 1}`;
        stripeState.subscriptions.push({
          id,
          customer: params.customer as string,
          metadata: (params.metadata ?? {}) as Record<string, string>,
        });
        stripeState.idempotency.set(idempotencyKey, id);
        return { id };
      },
    },
  };

  // ---- Vercel（RESTの形まで再現し、本物のクライアントを通します） ----
  type FakeProject = {
    id: string;
    name: string;
    link: { org: string; repo: string; productionBranch: string };
    envs: Map<string, { key: string; value: string; type: string }>;
    domains: Map<string, { name: string; apexName: string; verified: boolean; redirect?: string }>;
    sharedEnvIds: string[];
    ignoreCommand?: string;
  };
  const vercelState = {
    projects: [] as FakeProject[],
    deployments: [] as {
      id: string;
      projectId: string;
      state: string;
      polls: number;
      ref: string;
      target: string;
    }[],
    /** デプロイ完了までのポーリング回数 */
    pollsUntilReady: 1,
    /** 次に作るデプロイの最終状態 */
    nextDeployResult: "READY",
    /** DNSが反映済みか */
    dnsReady: false,
    /** DNS確認APIが応答しない回数（テスト用） */
    domainConfigTimeouts: 0,
    /** 指定回数の確認後にDNSを反映済みにします（ローカル検証用） */
    dnsChecksUntilReady: null as number | null,
    /** 本番ブランチAPIが効かない状況の再現 */
    branchApiIgnored: false,
  };
  const findProject = (idOrName: string) =>
    vercelState.projects.find((p) => p.id === idOrName || p.name === idOrName);
  const domainJson = (d: { name: string; apexName: string; verified: boolean }) => ({
    ...d,
    verified: d.verified,
    verification: d.verified
      ? []
      : [{ type: "TXT", domain: `_vercel.${d.apexName}`, value: `vc-domain-verify=${d.name},fake`, reason: "pending" }],
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const apiError = (status: number, code: string, message: string) =>
    json(status, { error: { code, message } });

  const vercelFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.vercel.com") throw new Error(`想定外の接続先: ${url.hostname}`);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    const route = (pattern: RegExp) => path.match(pattern);
    const op = (name: string, detail?: unknown) => {
      const failure = hit(name, detail ?? body);
      return failure
        ? apiError(failure.status ?? 500, failure.code ?? "fake_error", failure.message)
        : null;
    };
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/v11/projects") {
      const failed = op("vercel.createProject");
      if (failed) return failed;
      if (findProject(body.name)) return apiError(409, "conflict", "exists");
      const [org, repo] = body.gitRepository.repo.split("/");
      const project: FakeProject = {
        id: `prj_fake${vercelState.projects.length + 1}`,
        name: body.name,
        link: { org, repo, productionBranch: "main" },
        envs: new Map(body.environmentVariables.map((e: any) => [e.key, e])),
        domains: new Map(),
        sharedEnvIds: [],
        ignoreCommand: body.commandForIgnoringBuildStep,
      };
      vercelState.projects.push(project);
      return json(200, { id: project.id, name: project.name, link: project.link });
    }
    if ((m = route(/^\/v10\/projects\/([^/]+)\/env$/))) {
      const project = findProject(decodeURIComponent(m[1]));
      if (!project) return apiError(404, "not_found", "no project");
      if (method === "GET") {
        return json(200, { envs: [...project.envs.values()] });
      }
      const failed = op("vercel.upsertEnv");
      if (failed) return failed;
      for (const item of body) project.envs.set(item.key, item);
      return json(201, { created: body });
    }
    if ((m = route(/^\/v9\/projects\/([^/]+)\/branch$/)) && method === "PATCH") {
      const project = findProject(decodeURIComponent(m[1]));
      if (!project) return apiError(404, "not_found", "no project");
      const failed = op("vercel.setProductionBranch");
      if (failed) return failed;
      if (!vercelState.branchApiIgnored) project.link.productionBranch = body.branch;
      return json(200, { id: project.id, name: project.name, link: project.link });
    }
    if ((m = route(/^\/v9\/projects\/([^/]+)$/)) && method === "GET") {
      const project = findProject(decodeURIComponent(m[1]));
      return project
        ? json(200, { id: project.id, name: project.name, link: project.link })
        : apiError(404, "not_found", "no project");
    }
    if (path === "/v1/env" && method === "PATCH") {
      const failed = op("vercel.linkSharedEnv");
      if (failed) return failed;
      for (const [envId, update] of Object.entries<any>(body.updates)) {
        for (const projectId of update.projectIdUpdates.link) {
          const project = findProject(projectId);
          if (project && !project.sharedEnvIds.includes(envId)) project.sharedEnvIds.push(envId);
        }
      }
      return json(200, { updated: [], failed: [] });
    }
    if ((m = route(/^\/v10\/projects\/([^/]+)\/domains$/)) && method === "POST") {
      const project = findProject(decodeURIComponent(m[1]));
      if (!project) return apiError(404, "not_found", "no project");
      const failed = op("vercel.addProjectDomain");
      if (failed) return failed;
      const taken = vercelState.projects.some((p) => p !== project && p.domains.has(body.name));
      if (taken) return apiError(409, "domain_already_in_use", "別のプロジェクトで使用中です");
      if (project.domains.has(body.name)) return apiError(400, "domain_already_exists", "exists");
      const apexName = body.name.replace(/^www\./, "");
      const domain = { name: body.name, apexName, verified: vercelState.dnsReady, redirect: body.redirect };
      project.domains.set(body.name, domain);
      return json(200, domainJson(domain));
    }
    if ((m = route(/^\/v9\/projects\/([^/]+)\/domains\/([^/]+)(\/verify)?$/))) {
      const project = findProject(decodeURIComponent(m[1]));
      const domain = project?.domains.get(decodeURIComponent(m[2]));
      if (!domain) return apiError(404, "not_found", "no domain");
      if (m[3]) {
        if (!vercelState.dnsReady) return apiError(400, "missing_txt_record", "not yet");
        domain.verified = true;
      }
      return json(200, domainJson(domain));
    }
    if ((m = route(/^\/v6\/domains\/([^/]+)\/config$/))) {
      const failed = op("vercel.getDomainConfig");
      if (failed) return failed;
      if (vercelState.domainConfigTimeouts > 0) {
        vercelState.domainConfigTimeouts -= 1;
        throw new DOMException("timed out", "TimeoutError");
      }
      if (vercelState.dnsChecksUntilReady !== null && !vercelState.dnsReady) {
        vercelState.dnsChecksUntilReady -= 1;
        if (vercelState.dnsChecksUntilReady <= 0) vercelState.dnsReady = true;
      }
      return json(200, {
        misconfigured: !vercelState.dnsReady,
        recommendedIPv4: [{ rank: 1, value: ["76.76.21.241"] }],
        recommendedCNAME: [{ rank: 1, value: "fake.vercel-dns-017.com." }],
      });
    }
    if (path === "/v13/deployments" && method === "POST") {
      const failed = op("vercel.createDeployment");
      if (failed) return failed;
      const deployment = {
        id: `dpl_fake${vercelState.deployments.length + 1}`,
        projectId: body.project,
        state: "QUEUED",
        polls: 0,
        ref: body.gitSource.ref,
        target: body.target,
      };
      vercelState.deployments.push(deployment);
      return json(200, {
        id: deployment.id,
        url: `${body.name}-fake.vercel.app`,
        readyState: deployment.state,
        inspectorUrl: `https://vercel.example/${deployment.id}`,
        meta: { githubCommitRef: deployment.ref },
      });
    }
    if ((m = route(/^\/v13\/deployments\/([^/]+)$/)) && method === "GET") {
      const deployment = vercelState.deployments.find((d) => d.id === decodeURIComponent(m![1]));
      if (!deployment) return apiError(404, "not_found", "no deployment");
      deployment.polls += 1;
      deployment.state =
        deployment.polls >= vercelState.pollsUntilReady ? vercelState.nextDeployResult : "BUILDING";
      return json(200, {
        id: deployment.id,
        url: "fake.vercel.app",
        readyState: deployment.state,
        inspectorUrl: `https://vercel.example/${deployment.id}`,
        meta: { githubCommitRef: deployment.ref },
      });
    }
    if (path === "/v7/deployments" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      return json(200, {
        deployments: vercelState.deployments
          .filter((d) => d.projectId === projectId)
          .map((d) => ({ uid: d.id, url: "fake.vercel.app", state: d.state, meta: { githubCommitRef: d.ref } })),
      });
    }
    throw new Error(`偽Vercelに未定義のAPI: ${method} ${path}`);
  }) as typeof fetch;

  // ---- メール ----
  const mails: { to: string; subject: string; html: string }[] = [];
  const sendMail = async (to: string, subject: string, html: string) => {
    const failure = hit("mail.send", { to });
    if (failure) throw new Error(failure.message);
    mails.push({ to, subject, html });
  };

  const env: Record<string, string | undefined> = {
    PROVISION_VERCEL_ENV_MODE: "shared",
    PROVISION_VERCEL_SHARED_ENV_IDS: "env_shared_a,env_shared_b",
    STRIPE_DEFAULT_PRICE_ID: "price_fake",
  };

  const fakes = {
    calls,
    failOnce,
    stripeState,
    vercelState,
    mails,
    env,
    vercelFetch,
    configProblems: [] as string[],
    /** Firestore と Auth だけ本物（エミュレーター）を渡します */
    deps(db: Firestore, auth: Auth): ProvisioningDeps {
      return {
        db,
        auth,
        getStripe: async () => stripe,
        vercel: createVercelClient({ token: "fake-token", teamId: "team_fake", fetchImpl: vercelFetch }),
        sendMail,
        config: readConfig(env),
        findConfigProblems: () => fakes.configProblems,
        now: () => new Date(),
      };
    },
  };
  return fakes;
}

export type Fakes = ReturnType<typeof createFakes>;

/** next dev ではAPIごとにモジュールが分かれるため、状態を globalThis で共有します。 */
export function getSharedFakes(): Fakes {
  const store = globalThis as unknown as { __pageitProvisioningFakes?: Fakes };
  if (!store.__pageitProvisioningFakes) {
    const fakes = createFakes();
    fakes.vercelState.pollsUntilReady = 3;
    fakes.vercelState.dnsChecksUntilReady = 4;
    // 例: PROVISIONING_FAKE_FAIL_ONCE=vercel.createProject で失敗と再開を確認できます
    const failOp = process.env.PROVISIONING_FAKE_FAIL_ONCE;
    if (failOp) fakes.failOnce(failOp);
    store.__pageitProvisioningFakes = fakes;
  }
  return store.__pageitProvisioningFakes;
}
