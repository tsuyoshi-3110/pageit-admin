import Stripe from "stripe";
import { stripeConnect } from "@/lib/stripe-connect";

export const ZERO_DEC = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw",
  "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export const toMajor = (n: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? n ?? 0 : (n ?? 0) / 100;

export const safeErr = (e: unknown) => {
  try {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
};

export const fmtCur = (n: number, cur?: string, locale = "en") => {
  const c = (cur ?? "jpy").toUpperCase();
  const zero = ZERO_DEC.has(c.toLowerCase());
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: c,
    maximumFractionDigits: zero ? 0 : 2,
    minimumFractionDigits: zero ? 0 : 2,
  }).format(n);
};

/** Stripeから line items を取得 */
export async function fetchLineItems(
  sessionId: string,
  reqOpts?: Stripe.RequestOptions
) {
  return stripeConnect.checkout.sessions.listLineItems(
    sessionId,
    { limit: 100, expand: ["data.price.product"] },
    reqOpts
  );
}
