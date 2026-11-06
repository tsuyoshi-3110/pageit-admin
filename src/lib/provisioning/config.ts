import type { TenantInput } from "./types";

/** 新規店舗の公開元。既存店舗に影響しないよう専用ブランチに固定します。 */
export const STORE_GIT_ORG = "tsuyoshi-3110";
export const STORE_GIT_REPO = "pageit-platform";
export const STORE_GIT_BRANCH = "store-main";

/**
 * PAGEIT_SITE_KEY と VERCEL_PROJECT_ID 以外の環境変数の渡し方です。
 * - shared: Vercelの共有環境変数をリンクします（秘密情報が pageit-admin に増えません）
 * - copy:   pageit-admin がすでに持つ値のうち、指定したものだけを複製します
 * - none:   何も設定しません（Vercelの画面で設定する場合。未設定だとビルドは失敗します）
 */
export type EnvMode = "shared" | "copy" | "none";

export type ProvisioningConfig = {
  vercelTeamId: string | null;
  envMode: EnvMode | null;
  sharedEnvIds: string[];
  copyEnvKeys: string[];
  /** copy モードで複製する値の読み取り元 */
  env: Record<string, string | undefined>;
};

type Env = Record<string, string | undefined>;

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readConfig(env: Env): ProvisioningConfig {
  const mode = env.PROVISION_VERCEL_ENV_MODE?.trim();
  return {
    vercelTeamId: env.VERCEL_TEAM_ID?.trim() || null,
    envMode: mode === "shared" || mode === "copy" || mode === "none" ? mode : null,
    sharedEnvIds: list(env.PROVISION_VERCEL_SHARED_ENV_IDS),
    copyEnvKeys: list(env.PROVISION_VERCEL_COPY_ENV_KEYS),
    env,
  };
}

/**
 * 足りない設定の名前だけを返します（値は返しません）。
 * 事前確認で呼び、設定不足のまま何かを作り始めないようにします。
 */
export function findConfigProblems(env: Env, input: Pick<TenantInput, "plan">): string[] {
  const problems: string[] = [];
  const config = readConfig(env);
  const need = (name: string) => {
    if (!env[name]?.trim()) problems.push(`${name} が未設定です`);
  };

  need("VERCEL_TOKEN");
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_SENDER_EMAIL",
  ]) {
    need(name);
  }
  if (input.plan === "paid") {
    need("STRIPE_SECRET_KEY");
  }

  if (!config.envMode) {
    problems.push("PROVISION_VERCEL_ENV_MODE は shared / copy / none のいずれかを指定してください");
  } else if (config.envMode === "shared" && config.sharedEnvIds.length === 0) {
    problems.push("PROVISION_VERCEL_SHARED_ENV_IDS が未設定です");
  } else if (config.envMode === "copy") {
    if (config.copyEnvKeys.length === 0) {
      problems.push("PROVISION_VERCEL_COPY_ENV_KEYS が未設定です");
    }
    for (const key of config.copyEnvKeys) {
      if (!env[key]) problems.push(`複製元の ${key} が pageit-admin にありません`);
    }
  }
  return problems;
}
