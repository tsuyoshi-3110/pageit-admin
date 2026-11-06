import validator from "validator";
import { INDUSTRY_OPTIONS } from "../industries";
import type { TenantInput } from "./types";

export type InputErrors = Partial<Record<keyof TenantInput | "industryOther", string>>;

export type RawTenantInput = {
  siteName?: unknown;
  siteKey?: unknown;
  domain?: unknown;
  wwwEnabled?: unknown;
  ownerEmail?: unknown;
  industryKey?: unknown;
  industryOther?: unknown;
  plan?: unknown;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Vercelのプロジェクト名 pageit-{siteKey} にも使うため、小文字に限定します。
const SITE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

function isValidDomain(domain: string) {
  if (domain.length > 253 || !domain.includes(".")) return false;
  const labels = domain.split(".");
  return (
    /^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]) &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** 画面とAPIで共通の入力チェックです。 */
export function parseTenantInput(
  raw: RawTenantInput
): { ok: true; input: TenantInput } | { ok: false; errors: InputErrors } {
  const errors: InputErrors = {};

  const siteName = text(raw.siteName);
  if (!siteName) errors.siteName = "店名を入力してください。";
  else if (siteName.length > 100) errors.siteName = "店名は100文字以内で入力してください。";

  const siteKey = text(raw.siteKey);
  if (!SITE_KEY_PATTERN.test(siteKey) || siteKey.includes("--")) {
    errors.siteKey =
      "店舗キーは半角の英小文字・数字・ハイフンで2〜63文字にしてください（先頭と末尾は英数字、ハイフンの連続は不可）。";
  }

  const domain = text(raw.domain).toLowerCase();
  if (!isValidDomain(domain)) {
    errors.domain = "ドメインの形式が正しくありません。例: example.com";
  } else if (domain.startsWith("www.")) {
    errors.domain = "ドメインは www なしで入力し、www も使う場合はチェックを入れてください。";
  }

  const ownerEmail = text(raw.ownerEmail).toLowerCase();
  if (!validator.isEmail(ownerEmail)) {
    errors.ownerEmail = "メールアドレスの形式が正しくありません。";
  }

  const industryKey = text(raw.industryKey);
  const option = INDUSTRY_OPTIONS.find((item) => item.value === industryKey);
  const industryName = industryKey === "other" ? text(raw.industryOther) : option?.label ?? "";
  if (!option) errors.industry = "業種を選択してください。";
  else if (!industryName) errors.industryOther = "その他の業種を入力してください。";

  if (raw.plan !== "paid" && raw.plan !== "free") {
    errors.plan = "プランを選択してください。";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    input: {
      siteName,
      siteKey,
      domain,
      wwwEnabled: raw.wwwEnabled === true,
      ownerEmail,
      industry: { key: industryKey, name: industryName },
      plan: raw.plan as "paid" | "free",
    },
  };
}

export function hostsOf(input: Pick<TenantInput, "domain" | "wwwEnabled">) {
  return input.wwwEnabled ? [input.domain, `www.${input.domain}`] : [input.domain];
}

export function projectNameOf(siteKey: string) {
  return `pageit-${siteKey}`;
}
