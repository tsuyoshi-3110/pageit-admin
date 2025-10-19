// app/api/stripe/webhook/route.ts
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ========== 通貨桁＆表記 ========== */
const ZERO_DEC = new Set(["bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"]);
const THREE_DEC = new Set(["bhd","iqd","jod","kwd","lyd","omr","tnd"]);
const decimalsOf = (c?: string | null) => {
  const x = (c || "").toLowerCase();
  if (ZERO_DEC.has(x)) return 0;
  if (THREE_DEC.has(x)) return 3;
  return 2;
};
const formatMoney = (currency: string, minor: number) => {
  const d = decimalsOf(currency);
  const major = minor / Math.pow(10, d);
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
};

/* ========== 言語判定 ========== */
type LangKey = "ja" | "en" | "zh" | "zh-TW" | "ko" | "fr" | "es";
const SUPPORTED: LangKey[] = ["ja","en","zh","zh-TW","ko","fr","es"];
const resolveBuyerLang = (s: Stripe.Checkout.Session): LangKey => {
  const m = (s.metadata?.lang as string | undefined) || undefined;
  if (m && (SUPPORTED as string[]).includes(m)) return m as LangKey;
  const loc = (s.locale || "").toString();
  if ((SUPPORTED as string[]).includes(loc)) return loc as LangKey;
  return "en";
};

/* ========== 文言 ========== */
const M = {
  ja: {
    buyerSubject: "ご購入ありがとうございます",
    ownerSubject: "【注文通知】新しい注文が入りました",
    thanks: "このたびはご購入ありがとうございます。以下がご注文内容です。",
    summary: "ご注文サマリー",
    item: "商品",
    qty: "数量",
    unit: "単価",
    subtotal: "小計",
    total: "合計",
    name: "お名前",
    email: "メール",
    phone: "電話",
    address: "住所",
    payment: "決済手段",
    note: "本メールは自動送信です。",
    ownerHeading: "オーナー様向け注文通知（日本語固定）",
  },
  en: {
    buyerSubject: "Thank you for your purchase",
    ownerSubject: "New order received",
    thanks: "Thank you for your purchase. Here are your order details.",
    summary: "Order Summary",
    item: "Item",
    qty: "Qty",
    unit: "Unit Price",
    subtotal: "Subtotal",
    total: "Total",
    name: "Name",
    email: "Email",
    phone: "Phone",
    address: "Address",
    payment: "Payment Method",
    note: "This email was sent automatically.",
    ownerHeading: "Owner Notification (owner email is Japanese in practice)",
  },
  zh: { buyerSubject:"感谢您的购买", ownerSubject:"收到新订单", thanks:"感谢您的购买。以下是您的订单详情。", summary:"订单摘要", item:"商品", qty:"数量", unit:"单价", subtotal:"小计", total:"合计", name:"姓名", email:"邮箱", phone:"电话", address:"地址", payment:"支付方式", note:"此邮件为系统自动发送。", ownerHeading:"店主通知（店主邮件为日语）" },
  "zh-TW": { buyerSubject:"感謝您的購買", ownerSubject:"收到新訂單", thanks:"感謝您的購買。以下為您的訂單明細。", summary:"訂單摘要", item:"品項", qty:"數量", unit:"單價", subtotal:"小計", total:"總計", name:"姓名", email:"電子郵件", phone:"電話", address:"地址", payment:"付款方式", note:"本郵件為系統自動發送。", ownerHeading:"店主通知（店主郵件為日文）" },
  ko: { buyerSubject:"구매해 주셔서 감사합니다", ownerSubject:"새 주문이 접수되었습니다", thanks:"구매해 주셔서 감사합니다. 주문 상세는 아래와 같습니다.", summary:"주문 요약", item:"상품", qty:"수량", unit:"단가", subtotal:"소계", total:"합계", name:"이름", email:"이메일", phone:"전화", address:"주소", payment:"결제 수단", note:"이 메일은 자동 발송되었습니다.", ownerHeading:"점주 알림(점주 메일은 일본어)" },
  fr: { buyerSubject:"Merci pour votre achat", ownerSubject:"Nouvelle commande reçue", thanks:"Merci pour votre achat. Voici le récapitulatif de votre commande.", summary:"Récapitulatif de commande", item:"Article", qty:"Qté", unit:"Prix unitaire", subtotal:"Sous-total", total:"Total", name:"Nom", email:"E-mail", phone:"Téléphone", address:"Adresse", payment:"Mode de paiement", note:"E-mail envoyé automatiquement.", ownerHeading:"Notification propriétaire (mail réel en japonais)" },
  es: { buyerSubject:"Gracias por tu compra", ownerSubject:"Nuevo pedido recibido", thanks:"Gracias por tu compra. Estos son los detalles de tu pedido.", summary:"Resumen del pedido", item:"Artículo", qty:"Cant.", unit:"Precio unidad", subtotal:"Subtotal", total:"Total", name:"Nombre", email:"Correo", phone:"Teléfono", address:"Dirección", payment:"Método de pago", note:"Este correo se envió automáticamente.", ownerHeading:"Aviso al propietario (correo real en japonés)" },
} as const;

/* ========== 決済手段抽出 ========== */
type PMDetails = { type?: string; brand?: string; last4?: string; walletType?: string; extra?: Record<string, any> };
const extractPM = (pi: Stripe.PaymentIntent | null): PMDetails => {
  const ch = (pi?.latest_charge as Stripe.Charge | undefined) || undefined;
  const d = ch?.payment_method_details as Stripe.Charge.PaymentMethodDetails | undefined;
  if (!d) return {};
  const t = d.type;
  if (t === "card" && d.card) {
    return { type: "card", brand: d.card.brand || undefined, last4: d.card.last4 || undefined, extra: { funding: d.card.funding || undefined } };
  }
  if ((d as any).wallet) return { type: t, walletType: (d as any).wallet?.type || undefined };
  return { type: t };
};

/* ========== 住所・電話 ========== */
const resolvePhone = (s: Stripe.Checkout.Session, pi: Stripe.PaymentIntent | null) => {
  const fromCustomer = s.customer_details?.phone || undefined;
  if (fromCustomer) return fromCustomer;
  const ship = (s as any)?.shipping_details as { phone?: string | null } | undefined;
  if (ship?.phone) return ship.phone;
  const ch = (pi?.latest_charge as Stripe.Charge | undefined) || undefined;
  return ch?.billing_details?.phone || undefined;
};

/* ========== オーナーEmail取得（不足時に多段フォールバック） ========== */
const fetchOwnerEmail = async (siteKey?: string | null, metaOwnerEmail?: string | undefined) => {
  if (metaOwnerEmail && /\S+@\S+/.test(metaOwnerEmail)) return metaOwnerEmail;
  if (!siteKey) return process.env.FALLBACK_OWNER_EMAIL || undefined;
  try {
    const a = await adminDb.collection("siteSettings").doc(siteKey).get();
    if (a.exists && a.data()?.ownerEmail) return a.data()!.ownerEmail as string;
    const b = await adminDb.collection("siteSettingsEditable").doc(siteKey).get();
    if (b.exists && b.data()?.ownerEmail) return b.data()!.ownerEmail as string;
  } catch {}
  return process.env.FALLBACK_OWNER_EMAIL || undefined;
};

/* ========== メールHTML ========== */
type MailItem = { name: string; qty: number; unitMinor: number };
const renderEmail = (
  lang: LangKey,
  p: {
    isOwner: boolean;
    currency: string;
    totalMinor: number;
    items: MailItem[];
    customer: { name?: string | null; email?: string | null; phone?: string | null; addressText?: string };
    payment: PMDetails;
  }
) => {
  const T = M[lang];
  const rows = p.items.map((it) => {
    const unit = formatMoney(p.currency, it.unitMinor);
    const sub  = formatMoney(p.currency, it.unitMinor * it.qty);
    return `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${it.name}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${it.qty}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${unit}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${sub}</td>
    </tr>`;
  }).join("");
  const total = formatMoney(p.currency, p.totalMinor);
  const pmText =
    p.payment.type === "card"
      ? `card ${p.payment.brand ? p.payment.brand + " " : ""}${p.payment.last4 ? "****" + p.payment.last4 : ""}`.trim()
      : p.payment.type || "unknown";
  const heading = p.isOwner ? M.ja.ownerHeading : T.thanks;

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans',sans-serif;line-height:1.6;">
    <h2>${heading}</h2>
    ${p.isOwner ? "" : `<p>${T.thanks}</p>`}
    <h3>${T.summary}</h3>
    <table style="border-collapse:collapse;min-width:520px;">
      <thead>
        <tr>
          <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">${T.item}</th>
          <th style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${T.qty}</th>
          <th style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${T.unit}</th>
          <th style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${T.subtotal}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="padding:6px 8px;border:1px solid #ddd;text-align:right;font-weight:600;">${T.total}</td>
          <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;font-weight:600;">${total}</td>
        </tr>
      </tfoot>
    </table>

    <h3 style="margin-top:16px;">${T.payment}</h3>
    <p>${pmText}</p>

    <h3>${T.name} / ${T.email} / ${T.phone}</h3>
    <p>
      ${T.name}: ${p.customer.name || ""}<br/>
      ${T.email}: ${p.customer.email || ""}<br/>
      ${T.phone}: ${p.customer.phone || ""}
    </p>
    <h3>${T.address}</h3>
    <p>${p.customer.addressText || ""}</p>

    <p style="color:#666;">${T.note}</p>
  </div>`;
};

/* ========== ログ ========== */
const logWebhook = async (entry: any) => {
  try { await adminDb.collection("stripeWebhookLogs").add({ ...entry, createdAt: new Date() }); } catch {}
};

/* ========== Firestore 保存 ========== */
const saveOrder = async (args: {
  session: Stripe.Checkout.Session;
  itemsBuyer: MailItem[];
  itemsJa: MailItem[];
  pm: PMDetails;
  phone?: string;
  account?: string | null;
}) => {
  const { session, itemsBuyer, itemsJa, pm, phone, account } = args;
  const ship = (session as any)?.shipping_details as { address?: any; name?: string | null } | undefined;
  const addr = ship?.address || (session.customer_details?.address as any) || null;
  const addressText = addr ? [addr.country, addr.postal_code, addr.state, addr.city, addr.line1, addr.line2].filter(Boolean).join(" ") : "";

  const data = {
    siteKey: (session.metadata?.siteKey as string | undefined) || null,
    account,
    payment_status: session.payment_status,
    amount_total: session.amount_total || null,
    currency: session.currency || null,
    createdAt: new Date(),
    customer: {
      name: session.customer_details?.name || ship?.name || null,
      email: session.customer_details?.email || null,
      phone: phone || null,
      address: {
        country: addr?.country || null, postal_code: addr?.postal_code || null, state: addr?.state || null,
        city: addr?.city || null, line1: addr?.line1 || null, line2: addr?.line2 || null,
      },
      addressText,
    },
    items: itemsBuyer.map(i => ({ name: i.name, qty: i.qty, unitAmount: i.unitMinor })),
    items_ja: itemsJa.map(i => ({ name: i.name, qty: i.qty, unitAmount: i.unitMinor })),
    payment_method: pm,
    raw: { sessionId: session.id, payment_intent: session.payment_intent || null },
  };
  await adminDb.collection("orders").doc(session.id).set(data, { merge: true });
};

/* ========== 追加: メール宛先の堅牢化 ========== */
const getBuyerEmail = (s: Stripe.Checkout.Session, pi: Stripe.PaymentIntent | null) => {
  const a = s.customer_details?.email || undefined;
  if (a) return a;
  const ch = (pi?.latest_charge as Stripe.Charge | undefined) || undefined;
  const b = ch?.billing_details?.email || undefined;
  if (b) return b;
  return undefined;
};

/* ========== Webhook 本体 ========== */
export async function POST(req: NextRequest) {
  const raw = await req.arrayBuffer();
  const sig = (await headers()).get("stripe-signature");

  if (!sig) { await logWebhook({ level: "error", msg: "missing stripe-signature" }); return new Response("ok", { status: 200 }); }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(Buffer.from(raw), sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (e: any) {
    await logWebhook({ level: "error", msg: "constructEvent failed", error: String(e?.message || e) });
    return new Response("ok", { status: 200 });
  }

  const account = (event as any).account || null;
  const reqOpt = account ? { stripeAccount: account } : undefined;

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // line items（product 展開で「Item」回避）
      const li = await stripe.checkout.sessions.listLineItems(
        session.id, { limit: 100, expand: ["data.price.product"] }, reqOpt
      );

      // PI（決済手段/請求先メールfallback）
      let pi: Stripe.PaymentIntent | null = null;
      if (session.payment_intent) {
        const id = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
        pi = await stripe.paymentIntents.retrieve(
          id, { expand: ["latest_charge.payment_method_details","latest_charge.billing_details"] }, reqOpt
        );
      }

      const buyerLang = resolveBuyerLang(session);
      const pm = extractPM(pi);
      const phone = resolvePhone(session, pi);

      // 商品名（buyer: product.name / owner: product.metadata.name_ja 優先）
      const itemsBuyer: MailItem[] = [];
      const itemsJa:    MailItem[] = [];

      for (const x of li.data) {
        const qty = x.quantity ?? 1;
        const unitMinor =
          (x.price?.unit_amount as number | null | undefined) ??
          Math.round(((x.amount_subtotal || 0) / Math.max(1, qty)));

        const product = x.price?.product as Stripe.Product | string | null;
        const prodObj: Stripe.Product | undefined =
          product && typeof product !== "string" ? (product as Stripe.Product) : undefined;

        const meta: any = prodObj?.metadata || {};
        const nameBuyer = prodObj?.name || x.description || x.price?.nickname || "Item";
        const nameJa    = meta.name_ja || meta.name || prodObj?.name || x.description || x.price?.nickname || "Item";

        itemsBuyer.push({ name: String(nameBuyer), qty, unitMinor: Number(unitMinor || 0) });
        itemsJa.push({ name: String(nameJa), qty, unitMinor: Number(unitMinor || 0) });
      }

      // Firestore 保存（先に保存）
      await saveOrder({ session, itemsBuyer, itemsJa, pm, phone, account });

      // メール共通データ
      const currency = session.currency || "jpy";
      const totalMinor = session.amount_total || 0;
      const ship = (session as any)?.shipping_details as { address?: any; name?: string | null } | undefined;
      const addr = ship?.address || (session.customer_details?.address as any) || null;
      const addressText = addr ? [addr.country, addr.postal_code, addr.state, addr.city, addr.line1, addr.line2].filter(Boolean).join(" ") : "";
      const customer = {
        name: session.customer_details?.name || ship?.name || "",
        email: session.customer_details?.email || "",
        phone: phone || "",
        addressText,
      };

      // ===== 宛先の決定 =====
      const siteKey = (session.metadata?.siteKey as string | undefined) || null;
      const metaOwnerEmail = (session.metadata?.ownerEmail as string | undefined) || undefined; // ← もし作成側で渡せるなら使う
      const ownerEmail = await fetchOwnerEmail(siteKey, metaOwnerEmail);
      const buyerEmail = getBuyerEmail(session, pi);

      // ===== 送信（結果を必ずログ）=====
      // Owner（日本語固定）
      if (ownerEmail) {
        const ownerHtml = renderEmail("ja", { isOwner: true, currency, totalMinor, items: itemsJa, customer, payment: pm });
        try {
          await sendMail({ to: ownerEmail, subject: M.ja.ownerSubject, html: ownerHtml });
          await logWebhook({ level: "info", msg: "owner mail sent", to: ownerEmail, sessionId: session.id });
        } catch (e: any) {
          await logWebhook({ level: "error", msg: "owner mail failed", error: String(e?.message || e), to: ownerEmail, sessionId: session.id });
        }
      } else {
        await logWebhook({ level: "warn", msg: "ownerEmail not resolved", siteKey, sessionId: session.id });
      }

      // Buyer（購入時選択言語）
      if (buyerEmail) {
        const buyerHtml = renderEmail(buyerLang, { isOwner: false, currency, totalMinor, items: itemsBuyer, customer, payment: pm });
        try {
          await sendMail({ to: buyerEmail, subject: M[buyerLang].buyerSubject, html: buyerHtml });
          await logWebhook({ level: "info", msg: "buyer mail sent", to: buyerEmail, sessionId: session.id });
        } catch (e: any) {
          await logWebhook({ level: "error", msg: "buyer mail failed", error: String(e?.message || e), to: buyerEmail, sessionId: session.id });
        }
      } else {
        await logWebhook({ level: "warn", msg: "buyerEmail not resolved", sessionId: session.id });
      }

      // 受信ログ
      await logWebhook({
        level: "info",
        type: event.type,
        sessionId: session.id,
        currency,
        amount_total: totalMinor,
        account,
        pm,
      });

    } else {
      await logWebhook({ level: "debug", type: event.type, id: event.id, account });
    }
  } catch (e: any) {
    await logWebhook({ level: "error", msg: "webhook handler error", type: event.type, account, error: String(e?.message || e) });
    return new Response("ok", { status: 200 });
  }

  return new Response("ok", { status: 200 });
}
