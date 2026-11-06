/** 新規店舗追加の手順。この順に1つずつ実行します。 */
export const STEP_IDS = [
  "preflight",
  "ownerUser",
  "stripe",
  "firestore",
  "vercelProject",
  "vercelDomain",
  "deployment",
  "dns",
  "ownerMail",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  preflight: "事前確認",
  ownerUser: "オーナーのログインユーザー作成",
  stripe: "Stripeの顧客とサブスク作成",
  firestore: "Firestoreの初期データ作成",
  vercelProject: "Vercelプロジェクト作成",
  vercelDomain: "Vercelにドメイン追加",
  deployment: "デプロイ",
  dns: "DNSの反映確認",
  ownerMail: "オーナーへの案内メール送信",
};

export type StepStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";

export type RunStatus = "in_progress" | "waiting" | "failed" | "completed";

export type TenantInput = {
  siteName: string;
  siteKey: string;
  /** www なしのドメイン */
  domain: string;
  wwwEnabled: boolean;
  ownerEmail: string;
  industry: { key: string; name: string };
  plan: "paid" | "free";
};

export type StepError = { code: string; message: string };

export type StepState = {
  status: StepStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: StepError | null;
};

export type DnsRecord = { type: string; name: string; value: string };

export type DnsHostStatus = {
  host: string;
  verified: boolean;
  misconfigured: boolean;
  records: DnsRecord[];
};

export type Resources = {
  /** このユーザーIDで作成したものだけを再開時に再利用します */
  ownerUid: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  vercelProjectId: string | null;
  deployment: { id: string; url: string | null; state: string; inspectorUrl: string | null } | null;
  dns: { checkedAt: string; hosts: DnsHostStatus[] } | null;
  mail: { attemptedAt: string | null; sentAt: string | null };
};

export type ProvisioningRun = {
  provisioningId: string;
  siteKey: string;
  input: TenantInput;
  status: RunStatus;
  steps: Record<StepId, StepState>;
  resources: Resources;
  lock: { token: string; expiresAt: string } | null;
  createdAt: string;
  updatedAt: string;
};

/** 画面へ返す内容。内部用のロックは含めません。 */
export type ProvisioningView = Omit<ProvisioningRun, "lock"> & {
  /** 自動で再実行してよい場合の待ち時間（デプロイ完了待ちなど） */
  retryAfterMs: number | null;
  busy: boolean;
  /** まだ何も作っておらず、記録を破棄できるか */
  discardable: boolean;
  /** 案内メールを再送できるか */
  canResendMail: boolean;
};

export type Conflict = { field: "siteKey" | "domain" | "ownerEmail"; message: string };
