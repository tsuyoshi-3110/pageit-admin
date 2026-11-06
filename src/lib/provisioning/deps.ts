import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import type { ProvisioningConfig } from "./config";
import type { VercelClient } from "./vercel-client";

/** Stripeのうち、この処理で使う部分だけです。 */
export type StripePort = {
  customers: {
    list: (params: Stripe.CustomerListParams) => Promise<{ data: Pick<Stripe.Customer, "id" | "metadata">[] }>;
    create: (
      params: Stripe.CustomerCreateParams,
      options: { idempotencyKey: string }
    ) => Promise<Pick<Stripe.Customer, "id">>;
  };
};

export type SendMail = (to: string, subject: string, html: string) => Promise<unknown>;

/** 外部サービスへの入口です。テストではすべて偽物に差し替えます。 */
export type ProvisioningDeps = {
  db: Firestore;
  auth: Auth;
  /** 使うときに初めて読み込みます（無料プランでは不要なため） */
  getStripe: () => Promise<StripePort>;
  vercel: VercelClient;
  sendMail: SendMail;
  config: ProvisioningConfig;
  /** 足りない設定の一覧を返します */
  findConfigProblems: (plan: "paid" | "free") => string[];
  now: () => Date;
};
