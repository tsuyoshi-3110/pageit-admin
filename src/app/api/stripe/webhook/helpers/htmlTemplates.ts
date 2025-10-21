import { fmtCur, toMajor } from "./stripeUtils";
import type Stripe from "stripe";
import type { LangKey } from "./i18n";

/**
 * Stripeの型を拡張して shipping_details を安全に扱う
 */
interface CheckoutSessionEx extends Stripe.Checkout.Session {
  shipping_details?: {
    address?: {
      city?: string | null;
      country?: string | null;
      line1?: string | null;
      line2?: string | null;
      postal_code?: string | null;
      state?: string | null;
    } | null;
    name?: string | null;
    phone?: string | null;
  } | null;
}

export type MailItem = {
  names: Partial<Record<LangKey, string>> & { default: string };
  qty: number;
  unitAmount: number;
  subtotal: number;
};

export function buildOwnerHtmlJa(
  session: CheckoutSessionEx,
  items: MailItem[]
) {
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = "ja-JP";
  const ship = session.shipping_details ?? undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";

  const addr = [
    ship?.address?.postal_code ? `〒${ship.address.postal_code}` : "",
    ship?.address?.state,
    ship?.address?.city,
    ship?.address?.line1,
    ship?.address?.line2,
  ]
    .filter(Boolean)
    .join(" ");

  // 「buyer」変数はHTMLでも使うように変更（未使用警告回避）
  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items
    .map(
      (it) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">
            ${it.names.ja ?? it.names.default}
          </td>
          <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">
            ${fmtCur(it.unitAmount, cur, locale)}
          </td>
          <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">
            ${it.qty}
          </td>
          <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">
            ${fmtCur(it.subtotal, cur, locale)}
          </td>
        </tr>`
    )
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b></p>
    <p>購入者: <b>${buyer}</b></p>
    <table style="border-collapse:collapse;width:100%;max-width:680px;">
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:2px solid #333;">商品名</th>
          <th style="text-align:right;border-bottom:2px solid #333;">単価</th>
          <th style="text-align:center;border-bottom:2px solid #333;">数量</th>
          <th style="text-align:right;border-bottom:2px solid #333;">小計</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:12px;">合計: <b>${fmtCur(total, cur, locale)}</b></p>
    <h3>お届け先</h3>
    <p>氏名：${name}<br/>電話：${phone}<br/>住所：${addr || "-"}</p>
    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">
      このメールは Stripe Webhook により自動送信されています。
    </p>
  </div>`;
}
