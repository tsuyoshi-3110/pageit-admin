import { randomUUID } from "node:crypto";
import type { ProvisioningDeps } from "./deps";
import { findConflicts } from "./preflight";
import { STEP_HANDLERS, StepFailure, type StepResult } from "./steps";
import {
  STEP_IDS,
  type Conflict,
  type ProvisioningRun,
  type ProvisioningView,
  type Resources,
  type StepError,
  type StepId,
  type StepState,
  type TenantInput,
} from "./types";
import { isVercelApiError } from "./vercel-client";

/** 1回の実行で同時に動かないようにするロックの有効期間（API関数の上限より長く） */
const LOCK_MS = 90_000;

function runRef(deps: Pick<ProvisioningDeps, "db">, siteKey: string) {
  return deps.db.doc(`tenantProvisioning/${siteKey}`);
}

function emptySteps() {
  const blank: StepState = {
    status: "pending",
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  return Object.fromEntries(STEP_IDS.map((id) => [id, { ...blank }])) as Record<StepId, StepState>;
}

function nextStepOf(run: ProvisioningRun): StepId | null {
  return (
    STEP_IDS.find((id) => run.steps[id].status !== "done" && run.steps[id].status !== "skipped") ??
    null
  );
}

function lockActive(run: ProvisioningRun, now: Date) {
  return !!run.lock && new Date(run.lock.expiresAt) > now;
}

export function toView(
  run: ProvisioningRun,
  now: Date,
  retryAfterMs: number | null = null
): ProvisioningView {
  const rest: Omit<ProvisioningRun, "lock"> & { lock?: unknown } = { ...run };
  delete rest.lock;
  const mailStep = run.steps.ownerMail;
  return {
    ...(rest as Omit<ProvisioningRun, "lock">),
    retryAfterMs,
    busy: lockActive(run, now),
    discardable:
      !lockActive(run, now) &&
      run.steps.preflight.status !== "done" &&
      run.steps.ownerUser.status === "pending",
    canResendMail:
      mailStep.status === "done" || mailStep.error?.code === "mail-outcome-unknown",
  };
}

/** 秘密情報が画面や記録に残らないよう、想定外のエラーの文面を整えます。 */
function toStepError(error: unknown): StepError {
  if (error instanceof StepFailure) return { code: error.code, message: error.message };
  if (isVercelApiError(error)) {
    return { code: `vercel-${error.code}`, message: `Vercel: ${error.message}` };
  }
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: typeof code === "string" ? code : "unexpected",
    message: message
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/\b(sk|rk)_(live|test)_\w+/g, "$1_$2_***")
      .slice(0, 500),
  };
}

export class ProvisioningConflictError extends Error {
  constructor(
    readonly conflicts: Conflict[],
    /** 同じ店舗キーの追加処理がすでにある場合 */
    readonly existingRun: boolean
  ) {
    super("already-used");
    this.name = "ProvisioningConflictError";
  }
}

/**
 * 進行記録を作ります。使用済みの項目があれば何も作らず例外を投げます。
 * 手順の実行は advance で行います。
 */
export async function startProvisioning(
  deps: ProvisioningDeps,
  input: TenantInput
): Promise<ProvisioningView> {
  const ref = runRef(deps, input.siteKey);
  if ((await ref.get()).exists) {
    throw new ProvisioningConflictError(
      [{ field: "siteKey", message: `店舗キー「${input.siteKey}」の追加処理がすでにあります。` }],
      true
    );
  }
  const conflicts = await findConflicts(deps, input);
  if (conflicts.length > 0) throw new ProvisioningConflictError(conflicts, false);

  const now = deps.now().toISOString();
  const run: ProvisioningRun = {
    provisioningId: randomUUID(),
    siteKey: input.siteKey,
    input,
    status: "in_progress",
    steps: emptySteps(),
    resources: {
      ownerUid: `pageit-owner-${randomUUID()}`,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      vercelProjectId: null,
      deployment: null,
      dns: null,
      mail: { attemptedAt: null, sentAt: null },
    },
    lock: null,
    createdAt: now,
    updatedAt: now,
  };

  // 同時に開始された場合でも、同じドメインやメールアドレスで2件作らないようにします。
  const domainQuery = deps.db
    .collection("tenantProvisioning")
    .where("input.domain", "==", input.domain)
    .limit(1);
  const emailQuery = deps.db
    .collection("tenantProvisioning")
    .where("input.ownerEmail", "==", input.ownerEmail)
    .limit(1);
  await deps.db.runTransaction(async (tx) => {
    const [existing, sameDomain, sameEmail] = await Promise.all([
      tx.get(ref),
      tx.get(domainQuery),
      tx.get(emailQuery),
    ]);
    if (existing.exists || !sameDomain.empty || !sameEmail.empty) {
      throw new ProvisioningConflictError(
        [
          {
            field: existing.exists ? "siteKey" : !sameDomain.empty ? "domain" : "ownerEmail",
            message: "同じ内容の追加処理が同時に開始されました。一覧を確認してください。",
          },
        ],
        existing.exists
      );
    }
    tx.create(ref, run);
  });
  return toView(run, deps.now());
}

export async function getProvisioning(
  deps: ProvisioningDeps,
  siteKey: string
): Promise<ProvisioningView | null> {
  const snapshot = await runRef(deps, siteKey).get();
  return snapshot.exists ? toView(snapshot.data() as ProvisioningRun, deps.now()) : null;
}

export async function listUnfinished(deps: ProvisioningDeps): Promise<ProvisioningView[]> {
  const snapshot = await deps.db
    .collection("tenantProvisioning")
    .where("status", "in", ["in_progress", "waiting", "failed"])
    .limit(50)
    .get();
  return snapshot.docs
    .map((item) => toView(item.data() as ProvisioningRun, deps.now()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** まだ何も作っていない記録だけを、管理者の操作で破棄します。 */
export async function discardProvisioning(
  deps: ProvisioningDeps,
  siteKey: string
): Promise<"deleted" | "not-found" | "not-discardable"> {
  const ref = runRef(deps, siteKey);
  return deps.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return "not-found";
    const view = toView(snapshot.data() as ProvisioningRun, deps.now());
    if (!view.discardable) return "not-discardable";
    tx.delete(ref);
    return "deleted";
  });
}

export type AdvanceOptions = {
  /** 失敗で止まった手順をやり直します */
  resume?: boolean;
  /** 案内メールを送り直します（管理者が明示したときだけ） */
  resendMail?: boolean;
};

/**
 * 次の手順を1つだけ実行します。画面は結果を見て繰り返し呼び出します。
 * 関数の実行時間に収め、画面を閉じても途中から続けられるようにするためです。
 */
export async function advance(
  deps: ProvisioningDeps,
  siteKey: string,
  options: AdvanceOptions = {}
): Promise<ProvisioningView | null> {
  const ref = runRef(deps, siteKey);
  const token = randomUUID();

  const claimed = await deps.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const run = snapshot.data() as ProvisioningRun;
    const now = deps.now();

    if (lockActive(run, now)) return { run, stepId: null };

    if (options.resendMail) {
      if (!toView(run, now).canResendMail) return { run, stepId: null };
      run.steps.ownerMail = { ...run.steps.ownerMail, status: "pending", error: null };
      run.resources.mail = { attemptedAt: null, sentAt: null };
      run.status = "in_progress";
    }
    if (run.status === "completed") return { run, stepId: null };
    if (run.status === "failed" && !options.resume && !options.resendMail) {
      return { run, stepId: null };
    }

    const stepId = nextStepOf(run);
    if (!stepId) return { run, stepId: null };

    run.status = "in_progress";
    const step = run.steps[stepId];
    run.steps[stepId] = {
      ...step,
      status: "running",
      attempts: step.attempts + 1,
      startedAt: step.startedAt ?? now.toISOString(),
      error: null,
    };
    run.lock = { token, expiresAt: new Date(now.getTime() + LOCK_MS).toISOString() };
    run.updatedAt = now.toISOString();
    tx.set(ref, run);
    return { run, stepId };
  });

  if (!claimed) return null;
  const { run, stepId } = claimed;
  if (!stepId) return toView(run, deps.now());

  const saveResources = async (patch: Partial<Resources>) => {
    Object.assign(run.resources, patch);
    await ref.update(
      Object.fromEntries(Object.entries(patch).map(([key, value]) => [`resources.${key}`, value]))
    );
  };

  let result: StepResult | null = null;
  let failure: StepError | null = null;
  try {
    result = await STEP_HANDLERS[stepId]({ deps, run, saveResources });
  } catch (error) {
    failure = toStepError(error);
    console.error(`[provisioning] ${siteKey} ${stepId} failed: ${failure.code}`);
  }

  const finished = deps.now().toISOString();
  const committed = await deps.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const latest = snapshot.data() as ProvisioningRun | undefined;
    // ロックが切れて別の実行に引き継がれていたら、その結果を優先します
    if (!latest || latest.lock?.token !== token) return latest ?? null;

    const step = latest.steps[stepId];
    if (failure) {
      latest.steps[stepId] = { ...step, status: "failed", finishedAt: finished, error: failure };
      latest.status = "failed";
    } else if (result?.kind === "waiting") {
      latest.steps[stepId] = { ...step, status: "waiting", finishedAt: null };
      latest.status = "waiting";
    } else {
      latest.steps[stepId] = {
        ...step,
        status: result?.kind === "skipped" ? "skipped" : "done",
        finishedAt: finished,
      };
      latest.status = nextStepOf(latest) ? "in_progress" : "completed";
    }
    latest.lock = null;
    latest.updatedAt = finished;
    tx.set(ref, latest);
    return latest;
  });

  if (!committed) return null;
  return toView(
    committed,
    deps.now(),
    !failure && result?.kind === "waiting" ? result.retryAfterMs : null
  );
}
