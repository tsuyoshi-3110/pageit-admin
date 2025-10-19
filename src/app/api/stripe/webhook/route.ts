// app/api/stripe/webhook/route.ts
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ========================= 型/ユーティリティ ========================= */
type ShippingDetails = {
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
};

const ZERO_DEC = new Set([
  "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf",
]);

const toMajor = (minor: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? (minor ?? 0) : (minor ?? 0) / 100;

const fmtCur = (n: number, cur?: string, locale = "en") => {
  const c = (cur ?? "jpy").toUpperCase();
  const zero = ZERO_DEC.has(c.toLowerCase());
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: c,
    maximumFractionDigits: zero ? 0 : 2,
    minimumFractionDigits: zero ? 0 : 2,
  }).format(n);
};

const safeErr = (e: unknown) => {
  try {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch { return String(e); }
};

/* ========================= 言語 ========================= */
type LangKey =
  | "ja" | "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR" | "ko"
  | "zh" | "zh-TW" | "ru" | "th" | "vi" | "id";

const LOCALE_BY_LANG: Record<LangKey, string> = {
  ja: "ja-JP", en: "en", fr: "fr-FR", es: "es-ES", de: "de-DE", it: "it-IT",
  pt: "pt-PT", "pt-BR": "pt-BR", ko: "ko-KR", zh: "zh-CN", "zh-TW": "zh-TW",
  ru: "ru-RU", th: "th-TH", vi: "vi-VN", id: "id-ID",
};

const normalizeLang = (input?: string | null): LangKey => {
  const v = (input || "").toLowerCase();
  if (!v) return "en";
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("es-419") || v.startsWith("es")) return "es";
  if (v.startsWith("de")) return "de";
  if (v.startsWith("it")) return "it";
  if (v.startsWith("pt-br")) return "pt-BR";
  if (v.startsWith("pt")) return "pt";
  if (v.startsWith("ko")) return "ko";
  if (v.startsWith("zh-tw")) return "zh-TW";
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("ru")) return "ru";
  if (v.startsWith("th")) return "th";
  if (v.startsWith("vi")) return "vi";
  if (v.startsWith("id")) return "id";
  return "en";
};

/* ========================= ログ ========================= */
const logOrderMail = async (rec: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string | null;
  eventType: string;
  sent: boolean;
  reason?: string | null;
  extras?: Record<string, unknown>;
}) => {
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("orderMails").add({ ...rec, createdAt: FieldValue.serverTimestamp() });
};

/* ========================= 決済手段/電話 ========================= */
const extractPayment = (pi: Stripe.PaymentIntent | null) => {
  const ch = (pi?.latest_charge as Stripe.Charge | undefined) || undefined;
  const d = ch?.payment_method_details as Stripe.Charge.PaymentMethodDetails | undefined;
  const type = d?.type || undefined;
  const brand = d?.card?.brand || undefined;
  const last4 = d?.card?.last4 || undefined;
  return { type, brand, last4 };
};

const resolvePhone = (s: Stripe.Checkout.Session, pi: Stripe.PaymentIntent | null): string | undefined => {
  const a = s.customer_details?.phone || undefined;
  if (a) return a;
  const b = (s as any)?.shipping_details?.phone as string | undefined;
  if (b) return b;
  const ch = (pi?.latest_charge as Stripe.Charge | undefined) || undefined;
  return ch?.billing_details?.phone || undefined;
};

/* ========================= 商品名の解決（"Item"撲滅） ========================= */
type ResolvedItem = {
  buyerName: string;      // 購入者向け（選択言語）
  ownerJaName: string;    // オーナー向け（日本語）
  qty: number;
  unitMinor: number;
  subtotalMinor: number;
};

const resolveNames = (
  prod: Stripe.Product | undefined,
  buyerLang: LangKey,
  fallbackDesc?: string,
  fallbackNick?: string
): { buyerName: string; ownerJaName: string } => {
  const meta = (prod?.metadata as Record<string, string | undefined>) || {};

  const metaBuyer = meta[`name_${buyerLang}`];
  const metaJa = meta["name_ja"];
  const metaAny = meta["name"];

  const buyerName =
    (metaBuyer && metaBuyer.trim()) ||
    (prod?.name && prod.name.trim()) ||
    (fallbackDesc && fallbackDesc.trim()) ||
    (fallbackNick && fallbackNick.trim()) ||
    "Item";

  const ownerJaName =
    (metaJa && metaJa.trim()) ||
    (metaAny && metaAny.trim()) ||
    (prod?.name && prod.name.trim()) ||
    (fallbackDesc && fallbackDesc.trim()) ||
    (fallbackNick && fallbackNick.trim()) ||
    "Item";

  return { buyerName, ownerJaName };
};

const buildResolvedItems = async (
  session: Stripe.Checkout.Session,
  buyerLang: LangKey,
  reqOpts?: Stripe.RequestOptions
): Promise<ResolvedItem[]> => {
  const li = await stripe.checkout.sessions.listLineItems(
    session.id,
    { limit: 100, expand: ["data.price.product"] },
    reqOpts
  );

  return li.data.map((x) => {
    const qty = x.quantity ?? 1;

    const unitMinor =
      (x.price?.unit_amount as number | null | undefined) ??
      Math.round(((x.amount_subtotal || 0) / Math.max(1, qty)));

    const prod =
      x.price?.product && typeof x.price.product !== "string"
        ? (x.price.product as Stripe.Product)
        : undefined;

    // null → undefined へ正規化（型エラー対策）
    const desc: string | undefined = x.description ?? undefined;
    const nick: string | undefined = (x.price?.nickname ?? undefined) as string | undefined;

    const { buyerName, ownerJaName } = resolveNames(prod, buyerLang, desc, nick);

    return {
      buyerName,
      ownerJaName,
      qty,
      unitMinor: Number(unitMinor || 0),
      subtotalMinor: Number((x.amount_subtotal ?? unitMinor * qty) || 0),
    };
  });
};

/* ========================= メールHTML（オーナー/購入者） ========================= */
const buyerText: Record<LangKey, {
  subject: string; heading: string; orderId: string; payment: string; buyer: string;
  table: { name: string; unit: string; qty: string; subtotal: string; };
  total: string; shipTo: string; name: string; phone: string; address: string; footer: string;
}> = {
  ja: { subject:"ご購入ありがとうございます（レシート）", heading:"ご注文ありがとうございます",
    orderId:"注文ID", payment:"支払い", buyer:"購入者",
    table:{ name:"商品名", unit:"単価", qty:"数量", subtotal:"小計" },
    total:"合計", shipTo:"お届け先", name:"氏名", phone:"電話", address:"住所",
    footer:"このメールは Stripe Webhook により自動送信されています。" },
  en: { subject:"Thanks for your purchase (receipt)", heading:"Thank you for your order",
    orderId:"Order ID", payment:"Payment", buyer:"Buyer",
    table:{ name:"Item", unit:"Unit price", qty:"Qty", subtotal:"Subtotal" },
    total:"Total", shipTo:"Shipping address", name:"Name", phone:"Phone", address:"Address",
    footer:"This email was sent automatically by Stripe Webhook." },
  fr:{subject:"Merci pour votre achat (reçu)",heading:"Merci pour votre commande",
    orderId:"ID de commande",payment:"Paiement",buyer:"Acheteur",
    table:{name:"Article",unit:"Prix unitaire",qty:"Qté",subtotal:"Sous-total"},
    total:"Total",shipTo:"Adresse de livraison",name:"Nom",phone:"Téléphone",address:"Adresse",
    footer:"Cet e-mail a été envoyé automatiquement par Stripe Webhook."},
  es:{subject:"Gracias por su compra (recibo)",heading:"Gracias por su pedido",
    orderId:"ID de pedido",payment:"Pago",buyer:"Comprador",
    table:{name:"Producto",unit:"Precio unitario",qty:"Cant.",subtotal:"Subtotal"},
    total:"Total",shipTo:"Dirección de envío",name:"Nombre",phone:"Teléfono",address:"Dirección",
    footer:"Este correo fue enviado automáticamente por Stripe Webhook."},
  de:{subject:"Vielen Dank für Ihren Einkauf (Beleg)",heading:"Danke für Ihre Bestellung",
    orderId:"Bestell-ID",payment:"Zahlung",buyer:"Käufer",
    table:{name:"Artikel",unit:"Einzelpreis",qty:"Menge",subtotal:"Zwischensumme"},
    total:"Gesamt",shipTo:"Lieferadresse",name:"Name",phone:"Telefon",address:"Adresse",
    footer:"Diese E-Mail wurde automatisch vom Stripe Webhook gesendet."},
  it:{subject:"Grazie per l'acquisto (ricevuta)",heading:"Grazie per il tuo ordine",
    orderId:"ID ordine",payment:"Pagamento",buyer:"Acquirente",
    table:{name:"Articolo",unit:"Prezzo unitario",qty:"Qtà",subtotal:"Subtotale"},
    total:"Totale",shipTo:"Indirizzo di spedizione",name:"Nome",phone:"Telefono",address:"Indirizzo",
    footer:"Questa e-mail è stata inviata automaticamente dal webhook di Stripe."},
  pt:{subject:"Obrigado pela compra (recibo)",heading:"Obrigado pelo seu pedido",
    orderId:"ID do pedido",payment:"Pagamento",buyer:"Comprador",
    table:{name:"Item",unit:"Preço unitário",qty:"Qtd",subtotal:"Subtotal"},
    total:"Total",shipTo:"Endereço de entrega",name:"Nome",phone:"Telefone",address:"Endereço",
    footer:"Este e-mail foi enviado automaticamente pelo Stripe Webhook."},
  "pt-BR":{subject:"Obrigado pela compra (recibo)",heading:"Obrigado pelo seu pedido",
    orderId:"ID do pedido",payment:"Pagamento",buyer:"Comprador",
    table:{name:"Item",unit:"Preço unitário",qty:"Qtd",subtotal:"Subtotal"},
    total:"Total",shipTo:"Endereço de entrega",name:"Nome",phone:"Telefone",address:"Endereço",
    footer:"Este e-mail foi enviado automaticamente pelo Stripe Webhook."},
  ko:{subject:"구매해 주셔서 감사합니다 (영수증)",heading:"주문해 주셔서 감사합니다",
    orderId:"주문 ID",payment:"결제",buyer:"구매자",
    table:{name:"상품명",unit:"단价",qty:"수량",subtotal:"소계"},
    total:"합계",shipTo:"배송지",name:"이름",phone:"전화",address:"주소",
    footer:"이 메일은 Stripe Webhook에 의해 자동 전송되었습니다."},
  zh:{subject:"感谢您的购买（收据）",heading:"感谢您的订单",
    orderId:"订单编号",payment:"支付",buyer:"购买者",
    table:{name:"商品名称",unit:"单价",qty:"数量",subtotal:"小计"},
    total:"合计",shipTo:"收货地址",name:"姓名",phone:"电话",address:"地址",
    footer:"此邮件由 Stripe Webhook 自动发送。"},
  "zh-TW":{subject:"感謝您的購買（收據）",heading:"感謝您的訂單",
    orderId:"訂單編號",payment:"付款",buyer:"購買者",
    table:{name:"商品名稱",unit:"單價",qty:"數量",subtotal:"小計"},
    total:"合計",shipTo:"收件地址",name:"姓名",phone:"電話",address:"地址",
    footer:"此郵件由 Stripe Webhook 自動發送。"},
  ru:{subject:"Спасибо за покупку (квитанция)",heading:"Спасибо за ваш заказ",
    orderId:"ID заказа",payment:"Оплата",buyer:"Покупатель",
    table:{name:"Товар",unit:"Цена",qty:"Кол-во",subtotal:"Промежуточный итог"},
    total:"Итого",shipTo:"Адрес доставки",name:"Имя",phone:"Телефон",address:"Адрес",
    footer:"Это письмо отправлено автоматически через Stripe Webhook."},
  th:{subject:"ขอบคุณสำหรับการสั่งซื้อ (ใบเสร็จ)",heading:"ขอบคุณสำหรับคำสั่งซื้อ",
    orderId:"รหัสคำสั่งซื้อ",payment:"การชำระเงิน",buyer:"ผู้ซื้อ",
    table:{name:"สินค้า",unit:"ราคาต่อหน่วย",qty:"จำนวน",subtotal:"ยอดย่อย"},
    total:"ยอดรวม",shipTo:"ที่อยู่จัดส่ง",name:"ชื่อ",phone:"โทร",address:"ที่อยู่",
    footer:"อีเมลนี้ถูกส่งโดยอัตโนมัติจาก Stripe Webhook"},
  vi:{subject:"Cảm ơn bạn đã mua hàng (biên nhận)",heading:"Cảm ơn bạn đã đặt hàng",
    orderId:"Mã đơn hàng",payment:"Thanh toán",buyer:"Người mua",
    table:{name:"Sản phẩm",unit:"Đơn giá",qty:"SL",subtotal:"Tạm tính"},
    total:"Tổng",shipTo:"Địa chỉ giao hàng",name:"Tên",phone:"Điện thoại",address:"Địa chỉ",
    footer:"Email này được gửi tự động bởi Stripe Webhook."},
  id:{subject:"Terima kasih atas pembelian Anda (kwitansi)",heading:"Terima kasih atas pesanan Anda",
    orderId:"ID Pesanan",payment:"Pembayaran",buyer:"Pembeli",
    table:{name:"Produk",unit:"Harga satuan",qty:"Jml",subtotal:"Subtotal"},
    total:"Total",shipTo:"Alamat pengiriman",name:"Nama",phone:"Telepon",address:"Alamat",
    footer:"Email ini dikirim otomatis oleh Stripe Webhook."},
};

const buildOwnerHtmlJa = (
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: ResolvedItem[]
) => {
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = "ja-JP";
  const total = toMajor(session.amount_total, session.currency);

  const ship = (session as any).shipping_details as { name?: string | null; phone?: string | null; address?: Stripe.Address | null } | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;
  const addr = [
    addrObj?.postal_code ? `〒${addrObj.postal_code}` : "",
    addrObj?.state, addrObj?.city, addrObj?.line1, addrObj?.line2,
    addrObj?.country && addrObj.country !== "JP" ? addrObj.country : "",
  ].filter(Boolean).join(" ");

  const buyer = cust?.email || session.customer_email || "-";

  const rows = items.map((it) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${it.ownerJaName}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(toMajor(it.unitMinor, session.currency), cur, locale)}</td>
      <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(toMajor(it.subtotalMinor, session.currency), cur, locale)}</td>
    </tr>`).join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b>／支払い: <b>${session.payment_status}</b></p>
    <p>購入者: <b>${buyer}</b></p>
    <table style="border-collapse:collapse;width:100%;max-width:680px;">
      <thead><tr>
        <th style="text-align:left;border-bottom:2px solid #333;">商品名</th>
        <th style="text-align:right;border-bottom:2px solid #333;">単価</th>
        <th style="text-align:center;border-bottom:2px solid #333;">数量</th>
        <th style="text-align:right;border-bottom:2px solid #333;">小計</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:12px;">合計: <b>${fmtCur(total, cur, locale)}</b></p>
    <h3>お届け先</h3>
    <p>氏名：${name}<br/>電話：${phone}<br/>住所：${addr || "-"}</p>
    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">このメールは Stripe Webhook により自動送信されています。</p>
  </div>`;
};

const buildBuyerHtmlI18n = (
  lang: LangKey,
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: ResolvedItem[]
) => {
  const t = buyerText[lang] || buyerText.en;
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = LOCALE_BY_LANG[lang] || "en";
  const total = toMajor(session.amount_total, session.currency);

  const ship = (session as any).shipping_details as { name?: string | null; phone?: string | null; address?: Stripe.Address | null } | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;
  const addr = [
    addrObj?.postal_code, addrObj?.state, addrObj?.city, addrObj?.line1, addrObj?.line2,
    addrObj?.country && addrObj?.country !== "JP" ? addrObj.country : "",
  ].filter(Boolean).join(" ");

  const buyer = cust?.email || session.customer_email || "-";

  const rows = items.map((it) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${it.buyerName}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(toMajor(it.unitMinor, session.currency), cur, locale)}</td>
      <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(toMajor(it.subtotalMinor, session.currency), cur, locale)}</td>
    </tr>`).join("");

  return {
    subject: t.subject,
    html: `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
      <h2>${t.heading}</h2>
      <p>${t.orderId}: <b>${session.id}</b> / ${t.payment}: <b>${session.payment_status}</b></p>
      <p>${t.buyer}: <b>${buyer}</b></p>
      <table style="border-collapse:collapse;width:100%;max-width:680px;">
        <thead><tr>
          <th style="text-align:left;border-bottom:2px solid #333;">${t.table.name}</th>
          <th style="text-align:right;border-bottom:2px solid #333;">${t.table.unit}</th>
          <th style="text-align:center;border-bottom:2px solid #333;">${t.table.qty}</th>
          <th style="text-align:right;border-bottom:2px solid #333;">${t.table.subtotal}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:12px;"><b>${t.total}: ${fmtCur(total, cur, locale)}</b></p>
      <h3>${t.shipTo}</h3>
      <p>${t.name}: ${name}<br/>${t.phone}: ${phone}<br/>${t.address}: ${addr || "-"}</p>
      <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
      <p style="color:#666;font-size:12px;">${t.footer}</p>
    </div>`,
  };
};

/* ========================= Webhook 本体 ========================= */
export async function POST(req: NextRequest) {
  const body = await req.text();

  // ★ ここを await に修正（headers() が Promise<ReadonlyHeaders> な環境向け）
  const sig = (await headers()).get("stripe-signature");

  if (!sig) {
    await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: null, eventType: "missing_signature", sent: false, reason: "stripe-signature header missing" });
    return new Response("OK", { status: 200 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: null, eventType: "signature_error", sent: false, reason: `signature error: ${safeErr(err)}` });
    return new Response("OK", { status: 200 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const account = (event as any).account as string | undefined;
  const reqOpts: Stripe.RequestOptions | undefined = account ? { stripeAccount: account } : undefined;

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string; lang?: string };
    shipping_details?: ShippingDetails;
  };

  try {
    /* A) PaymentIntent（決済手段/電話） */
    const piId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    const pi = piId
      ? await stripe.paymentIntents.retrieve(
          piId,
          { expand: ["latest_charge.payment_method_details", "latest_charge.billing_details"] },
          reqOpts
        )
      : null;

    const pm = extractPayment(pi);
    const phone = resolvePhone(session, pi);

    /* B) 明細（"Item"回避 & 型エラー回避） */
    const buyerLang = normalizeLang(session.metadata?.lang || (session.locale as string) || "en");
    const items = await buildResolvedItems(session, buyerLang, reqOpts);

    /* C) Firestore 保存（簡易） */
    await adminDb.collection("siteOrders").add({
      siteKey: session.metadata?.siteKey || null,
      createdAt: new Date(),
      stripeCheckoutSessionId: session.id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      payment_type: pm.type || null,
      card_brand: pm.brand || null,
      card_last4: pm.last4 || null,
      customer: {
        email: session.customer_details?.email ?? null,
        name: session.customer_details?.name ?? (session as any).shipping_details?.name ?? null,
        phone: phone ?? null,
        address:
          session.customer_details?.address ??
          (session as any).shipping_details?.address ??
          null,
      },
      items: items.map((i) => ({
        name_buyer: i.buyerName,
        name_owner_ja: i.ownerJaName,
        qty: i.qty,
        unit_minor: i.unitMinor,
        subtotal_minor: i.subtotalMinor,
      })),
      buyer_lang: buyerLang,
    });

    /* D) オーナー宛（日本語固定） */
    const siteKey = session.metadata?.siteKey || null;
    if (siteKey) {
      const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
      const ownerEmail = (doc.get("ownerEmail") as string | undefined) || undefined;
      if (ownerEmail) {
        const ownerHtml = buildOwnerHtmlJa(session, items);
        try {
          await sendMail({ to: ownerEmail, subject: "【注文通知】新しい注文が完了しました", html: ownerHtml });
          await logOrderMail({ siteKey, ownerEmail, sessionId: session.id, eventType: event.type, sent: true });
        } catch (e) {
          await logOrderMail({
            siteKey, ownerEmail, sessionId: session.id, eventType: event.type, sent: false,
            reason: `sendMail(owner) failed: ${safeErr(e)}`,
          });
        }
      } else {
        await logOrderMail({ siteKey, ownerEmail: null, sessionId: session.id, eventType: event.type, sent: false, reason: "ownerEmail not found" });
      }
    } else {
      await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: session.id, eventType: event.type, sent: false, reason: "siteKey unresolved" });
    }

    /* E) 購入者宛（選択言語） */
    const buyerEmail = session.customer_details?.email || session.customer_email || null;
    if (buyerEmail) {
      const buyerMail = buildBuyerHtmlI18n(buyerLang, session, items);
      try {
        await sendMail({ to: buyerEmail, subject: buyerMail.subject, html: buyerMail.html });
      } catch (e) {
        await logOrderMail({
          siteKey: siteKey ?? null, ownerEmail: null, sessionId: session.id, eventType: "buyer_mail_failed",
          sent: false, reason: safeErr(e)
        });
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    await logOrderMail({
      siteKey: session.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: session.id,
      eventType: "handler_error",
      sent: false,
      reason: `handler error: ${safeErr(err)}`
    });
    return new Response("OK", { status: 200 });
  }
}
