/** 新規店舗追加で使う Vercel REST API です。fetch を差し替えてテストできます。 */

const BASE_URL = "https://api.vercel.com";
const TIMEOUT_MS = 15_000;
/** DNSを実際に調べるAPIは、実測で18〜22秒かかります。関数の上限（60秒）に収まる長さにしています。 */
const DOMAIN_CONFIG_TIMEOUT_MS = 40_000;

export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

/** 開発サーバーではAPIごとにモジュールが分かれるため、instanceof ではなく名前で判定します。 */
export function isVercelApiError(error: unknown): error is VercelApiError {
  return error instanceof Error && error.name === "VercelApiError";
}

export type VercelEnvVar = {
  key: string;
  value: string;
  type: "plain" | "encrypted";
  target: string[];
};

export type VercelProject = {
  id: string;
  name: string;
  link?: { org?: string; repo?: string; productionBranch?: string } | null;
};

export type VercelProjectDomain = {
  name: string;
  apexName: string;
  verified: boolean;
  verification?: { type: string; domain: string; value: string; reason?: string }[];
};

export type VercelDomainConfig = {
  misconfigured: boolean;
  recommendedIPv4?: { rank: number; value: string[] }[];
  recommendedCNAME?: { rank: number; value: string }[];
};

export type VercelDeployment = {
  id: string;
  url: string | null;
  state: string;
  inspectorUrl: string | null;
  ref: string | null;
};

function toDeployment(raw: any): VercelDeployment {
  return {
    id: raw.id ?? raw.uid,
    url: raw.url ?? null,
    state: raw.readyState ?? raw.state ?? "UNKNOWN",
    inspectorUrl: raw.inspectorUrl ?? raw.inspector_url ?? null,
    ref: raw.meta?.githubCommitRef ?? null,
  };
}

export function createVercelClient({
  token,
  teamId,
  fetchImpl = fetch,
}: {
  token: string;
  teamId: string | null;
  fetchImpl?: typeof fetch;
}) {
  async function request<T>(
    method: string,
    path: string,
    {
      query,
      body,
      timeoutMs = TIMEOUT_MS,
    }: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
  ): Promise<T> {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    if (teamId) url.searchParams.set("teamId", teamId);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new VercelApiError(
        0,
        timedOut ? "timeout" : "network",
        timedOut ? "Vercelからの応答がありませんでした。" : "Vercelに接続できませんでした。"
      );
    }

    const data = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      throw new VercelApiError(
        response.status,
        data?.error?.code ?? `http-${response.status}`,
        data?.error?.message ?? `Vercel APIがエラーを返しました（${response.status}）。`
      );
    }
    return data as T;
  }

  async function orNull<T>(call: Promise<T>): Promise<T | null> {
    try {
      return await call;
    } catch (error) {
      if (isVercelApiError(error) && error.status === 404) return null;
      throw error;
    }
  }

  const project = (id: string) => `/projects/${encodeURIComponent(id)}`;

  return {
    getProject: (idOrName: string) =>
      orNull(request<VercelProject>("GET", `/v9${project(idOrName)}`)),

    createProject: (body: {
      name: string;
      framework: string;
      gitRepository: { type: "github"; repo: string };
      environmentVariables: VercelEnvVar[];
      commandForIgnoringBuildStep: string;
    }) => request<VercelProject>("POST", "/v11/projects", { body }),

    async listEnv(projectId: string) {
      const data = await request<{ envs?: { key: string; value?: string }[] }>(
        "GET",
        `/v10${project(projectId)}/env`
      );
      return data.envs ?? [];
    },

    upsertEnv: (projectId: string, vars: VercelEnvVar[]) =>
      request("POST", `/v10${project(projectId)}/env`, {
        query: { upsert: "true" },
        body: vars,
      }),

    /**
     * 公開ドキュメントに記載のないAPIです（Vercel公式のTerraformプロバイダが使用）。
     * 呼び出し側で設定後の値を読み直して確認します。
     */
    setProductionBranch: (projectId: string, branch: string) =>
      request<VercelProject>("PATCH", `/v9${project(projectId)}/branch`, { body: { branch } }),

    async linkSharedEnv(envIds: string[], projectId: string) {
      const updates = Object.fromEntries(
        envIds.map((id) => [id, { projectIdUpdates: { link: [projectId] } }])
      );
      const data = await request<{ failed?: { error?: { message?: string } }[] }>(
        "PATCH",
        "/v1/env",
        { body: { updates } }
      );
      if (data?.failed?.length) {
        throw new VercelApiError(
          200,
          "shared-env-link-failed",
          data.failed[0].error?.message ?? "共有環境変数をリンクできませんでした。"
        );
      }
    },

    getProjectDomain: (projectId: string, host: string) =>
      orNull(
        request<VercelProjectDomain>(
          "GET",
          `/v9${project(projectId)}/domains/${encodeURIComponent(host)}`
        )
      ),

    addProjectDomain: (
      projectId: string,
      body: { name: string; redirect?: string; redirectStatusCode?: number }
    ) => request<VercelProjectDomain>("POST", `/v10${project(projectId)}/domains`, { body }),

    verifyProjectDomain: (projectId: string, host: string) =>
      request<VercelProjectDomain>(
        "POST",
        `/v9${project(projectId)}/domains/${encodeURIComponent(host)}/verify`
      ),

    getDomainConfig: (host: string, projectId: string) =>
      request<VercelDomainConfig>("GET", `/v6/domains/${encodeURIComponent(host)}/config`, {
        query: { projectIdOrName: projectId },
        timeoutMs: DOMAIN_CONFIG_TIMEOUT_MS,
      }),

    async createDeployment(body: {
      name: string;
      project: string;
      target: "production";
      gitSource: { type: "github"; org: string; repo: string; ref: string };
    }) {
      return toDeployment(await request("POST", "/v13/deployments", { body }));
    },

    async getDeployment(id: string) {
      return toDeployment(await request("GET", `/v13/deployments/${encodeURIComponent(id)}`));
    },

    async listProductionDeployments(projectId: string) {
      const data = await request<{ deployments?: unknown[] }>("GET", "/v7/deployments", {
        query: { projectId, target: "production", limit: "10" },
      });
      return (data.deployments ?? []).map(toDeployment);
    },
  };
}

export type VercelClient = ReturnType<typeof createVercelClient>;
