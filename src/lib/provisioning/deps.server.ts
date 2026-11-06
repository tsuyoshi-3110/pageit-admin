import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { findConfigProblems, readConfig } from "./config";
import type { ProvisioningDeps, StripePort } from "./deps";
import { createVercelClient } from "./vercel-client";

/**
 * ローカル検証専用の偽物に切り替えます。
 * Firebaseの両エミュレーターに接続しているときだけ有効で、本番では使えません。
 */
async function localFakeDeps(): Promise<ProvisioningDeps> {
  const emulators =
    process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!emulators || process.env.VERCEL) {
    throw new Error("PROVISIONING_FAKE_EXTERNALS はエミュレーター接続時のみ使えます。");
  }
  const { getSharedFakes } = await import("./testing/fakes");
  const fakes = getSharedFakes();
  return { ...fakes.deps(adminDb, adminAuth) };
}

/** 本番用の入口です。APIの認可を通過した後に呼びます。 */
export async function getProvisioningDeps(): Promise<ProvisioningDeps> {
  if (process.env.PROVISIONING_FAKE_EXTERNALS === "1") return localFakeDeps();

  const env = process.env;
  return {
    db: adminDb,
    auth: adminAuth,
    async getStripe() {
      const { stripe } = await import("@/lib/stripe");
      return stripe as unknown as StripePort;
    },
    vercel: createVercelClient({
      token: env.VERCEL_TOKEN ?? "",
      teamId: env.VERCEL_TEAM_ID?.trim() || null,
    }),
    async sendMail(to, subject, html) {
      // lib/mailer.ts はSMTPの通信内容をログへ出すため、パスワード設定リンクを含むこのメールには使いません
      const { sendMail } = await import("@/lib/sendGmail");
      return sendMail(to, subject, html);
    },
    config: readConfig(env),
    findConfigProblems: (plan) => findConfigProblems(env, { plan }),
    now: () => new Date(),
  };
}
