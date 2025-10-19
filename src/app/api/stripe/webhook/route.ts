// app/api/stripe/webhook/route.ts
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ----------------------------------------------------------------
   型・ユーティリティ
---------------------------------------------------------------- */
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
const toMajor = (n: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? (n ?? 0) : (n ?? 0) / 100;

const safeErr = (e: unknown) => {
  try {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch { return String(e); }
};

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

const LOCALE_BY_LANG: Record<string, string> = {
  ja: "ja-JP", en: "en", fr: "fr-FR", es: "es-ES", de: "de-DE", it: "it-IT",
  pt: "pt-PT", "pt-BR": "pt-BR", ko: "ko-KR", zh: "zh-CN", "zh-TW": "zh-TW",
  ru: "ru-RU", th: "th-TH", vi: "vi-VN", id: "id-ID",
};

/* ----------------------------------------------------------------
   Firestore helpers
---------------------------------------------------------------- */
async function findSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb.collection("siteSettings")
    .where("stripeCustomerId", "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}
async function findSiteKeyByConnectAccount(connectAccountId: string): Promise<string | null> {
  const snap = await adminDb.collection("siteSellers")
    .where("stripe.connectAccountId", "==", connectAccountId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}
async function getOwnerEmail(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}
async function logOrderMail(rec: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string | null;
  eventType: string;
  sent: boolean;
  reason?: string | null;
  extras?: Record<string, unknown>;
}) {
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("orderMails").add({ ...rec, createdAt: FieldValue.serverTimestamp() });
}

/* ----------------------------------------------------------------
   言語
---------------------------------------------------------------- */
type LangKey =
  | "ja" | "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR" | "ko"
  | "zh" | "zh-TW" | "ru" | "th" | "vi" | "id";

function normalizeLang(input?: string | null): LangKey {
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
}

/* ----------------------------------------------------------------
   i18n 文言
---------------------------------------------------------------- */
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
    table:{name:"상품명",unit:"단가",qty:"수량",subtotal:"소계"},
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

/* ----------------------------------------------------------------
   明細生成：Stripe line_items から構築（配列順フォールバック付き）
---------------------------------------------------------------- */
type MailItem = {
  names: Partial<Record<LangKey, string>> & { default: string };
  qty: number;
  unitAmount: number;
  subtotal: number;
};
const getName = (mi: MailItem, lang: LangKey): string => mi.names[lang] || mi.names.default;

async function buildItemsFromStripe(
  session: Stripe.Checkout.Session,
  reqOpts?: Stripe.RequestOptions
): Promise<MailItem[]> {
  const li = await stripe.checkout.sessions.listLineItems(
    session.id,
    { expand: ["data.price.product"], limit: 100 },
    reqOpts
  );

  // items_i18n を “連想配列(by id)” と “配列（順序保持）” の両方で用意
  type I18nRow = { id?: string; qty?: number; names?: Record<string, string> };
  let i18nArray: I18nRow[] = [];
  let i18nById: Record<string, I18nRow> = {};
  try {
    const raw = (session.metadata as any)?.items_i18n;
    if (raw) {
      i18nArray = JSON.parse(raw) as I18nRow[];
      i18nById = Object.fromEntries(
        i18nArray
          .filter(r => typeof r?.id === "string" && r.id)
          .map(r => [r.id as string, r])
      );
    }
  } catch {
    // no-op
  }

  return li.data.map((x, idx) => {
    const prod = x.price?.product as Stripe.Product | string | undefined;
    const prodObj = (prod && typeof prod !== "string") ? (prod as Stripe.Product) : undefined;

    // productId が拾えないケースを考慮（順序でフォールバック）
    const pid = (prodObj?.metadata as any)?.productId as string | undefined;
    const rowFromId = pid ? i18nById[pid] : undefined;
    const rowFromIdx = i18nArray[idx];

    // name_xx を集約（metadata → items_i18n[idx] → items_i18n[id] の優先順）
    const names: MailItem["names"] = { default: "" };
    const prefer = (langKey: string): string | undefined => {
      const k = `name_${langKey}`;
      return (
        (prodObj?.metadata as any)?.[k] ??
        rowFromIdx?.names?.[langKey] ??
        rowFromId?.names?.[langKey]
      );
    };

    (["ja","en","fr","es","de","it","pt","pt-BR","ko","zh","zh-TW","ru","th","vi","id"] as LangKey[])
      .forEach((lk) => {
        const v =
          prefer(lk) ??
          // 互換：name が ja のみ入っている旧形式
          (lk === "ja" ? (prodObj?.metadata as any)?.name : undefined);
        if (typeof v === "string" && v.trim()) names[lk] = v.trim();
      });

    // 既定名（“Item” 落ち回避のため items_i18n も優先度に入れる）
    names.default =
      (prodObj?.metadata as any)?.name ||
      prodObj?.name ||
      rowFromIdx?.names?.ja ||
      rowFromId?.names?.ja ||
      rowFromIdx?.names?.en ||
      rowFromId?.names?.en ||
      x.description ||
      "Item";

    // 数量：line_item → items_i18n[idx] → items_i18n[id]
    const qty =
      x.quantity ??
      rowFromIdx?.qty ??
      rowFromId?.qty ??
      1;

    // 金額（購入通貨）
    const subMajor = toMajor(x.amount_subtotal ?? x.amount_total ?? 0, session.currency);
    const unitMajor = subMajor / Math.max(1, qty);

    return { names, qty, unitAmount: unitMajor, subtotal: subMajor };
  });
}

/* ----------------------------------------------------------------
   メールHTML（オーナー：日本語固定）
---------------------------------------------------------------- */
function buildOwnerHtmlJa(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: MailItem[]
) {
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = "ja-JP";

  const ship = (session as any).shipping_details as
    | { name?: string | null; phone?: string | null; address?: Stripe.Address | null }
    | undefined;
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
  const total = toMajor(session.amount_total, session.currency);

  const rows = items.map((it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(it, "ja")}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.unitAmount, cur, locale)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.subtotal, cur, locale)}</td>
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
}

/* ----------------------------------------------------------------
   メールHTML（購入者：多言語）
---------------------------------------------------------------- */
function buildBuyerHtmlI18n(
  lang: LangKey,
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: MailItem[]
) {
  const t = buyerText[lang] || buyerText.en;
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = LOCALE_BY_LANG[lang] || "en";

  const ship = (session as any).shipping_details as
    | { name?: string | null; phone?: string | null; address?: Stripe.Address | null }
    | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;

  const addr = [
    addrObj?.postal_code, addrObj?.state, addrObj?.city, addrObj?.line1, addrObj?.line2,
    addrObj?.country && addrObj?.country !== "JP" ? addrObj.country : "",
  ].filter(Boolean).join(" ");

  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items.map((it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(it, lang)}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.unitAmount, cur, locale)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.subtotal, cur, locale)}</td>
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
}

/* ----------------------------------------------------------------
   Webhook 本体
---------------------------------------------------------------- */
export async function POST(req: NextRequest) {
  // 生ボディ＆署名
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    console.error("⚠️ Missing stripe-signature header");
    await logOrderMail({
      siteKey: null, ownerEmail: null, sessionId: null,
      eventType: "missing_signature", sent: false,
      reason: "stripe-signature header missing",
    });
    return new Response("OK", { status: 200 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", safeErr(err));
    await logOrderMail({
      siteKey: null, ownerEmail: null, sessionId: null,
      eventType: "signature_error", sent: false,
      reason: `signature error: ${safeErr(err)}`,
    });
    return new Response("OK", { status: 200 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts: Stripe.RequestOptions | undefined =
    connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string; lang?: string };
    shipping_details?: ShippingDetails;
  };

  try {
    /* A) PaymentIntent / 決済手段 & 電話番号 */
    let pi: Stripe.PaymentIntent | null = null;
    try {
      pi = await stripe.paymentIntents.retrieve(
        session.payment_intent as string,
        { expand: ["latest_charge"] },
        reqOpts
      );
    } catch (e) {
      console.warn("⚠️ paymentIntents.retrieve failed:", safeErr(e));
    }
    const ch = pi?.latest_charge as Stripe.Charge | undefined;
    const pm = ch?.payment_method_details;
    const paymentType = pm?.type || null;
    const cardBrand = pm?.card?.brand || null;
    const last4 = pm?.card?.last4 || null;

    const phoneFallback =
      session.customer_details?.phone ??
      (session as any).shipping_details?.phone ??
      ch?.billing_details?.phone ??
      null;

    /* B) 明細（Stripe line_items 起点） */
    const buyerLang = normalizeLang(session.metadata?.lang || (session.locale as any) || "en");
    let items: MailItem[] = [];
    try {
      items = await buildItemsFromStripe(session, reqOpts);
    } catch (e) {
      console.error("❌ listLineItems failed:", safeErr(e));
      const totalMajor = toMajor(session.amount_total, session.currency);
      items = [{ names: { default: "Item" }, qty: 1, unitAmount: totalMajor, subtotal: totalMajor }];
    }

    /* C) Firestore 保存 */
    await adminDb.collection("siteOrders").add({
      siteKey: session.metadata?.siteKey || null,
      createdAt: new Date(),
      stripeCheckoutSessionId: session.id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      payment_type: paymentType,
      card_brand: cardBrand,
      card_last4: last4,
      customer: {
        email: session.customer_details?.email ?? null,
        name: session.customer_details?.name ?? (session as any).shipping_details?.name ?? null,
        phone: phoneFallback,
        address:
          session.customer_details?.address ??
          (session as any).shipping_details?.address ??
          null,
      },
      items: items.map(i => ({
        name: i.names.default,
        qty: i.qty,
        unitAmount: i.unitAmount,
        subtotal: i.subtotal,
      })),
      buyer_lang: buyerLang,
    });

    /* D) siteKey 解決 & stripeCustomerId 保存 */
    const customerId = (session.customer as string) || null;
    const siteKey: string | null =
      session.metadata?.siteKey
      ?? (connectedAccountId ? await findSiteKeyByConnectAccount(connectedAccountId) : null)
      ?? session.client_reference_id
      ?? (customerId ? await findSiteKeyByCustomerId(customerId) : null);

    if (siteKey && customerId) {
      await adminDb.doc(`siteSettings/${siteKey}`).set(
        { stripeCustomerId: customerId },
        { merge: true }
      );
    }

    /* E) オーナー宛（日本語固定） */
    if (siteKey) {
      const ownerEmail = await getOwnerEmail(siteKey);
      if (ownerEmail) {
        const ownerHtml = buildOwnerHtmlJa(session, items);
        try {
          await sendMail({
            to: ownerEmail,
            subject: "【注文通知】新しい注文が完了しました",
            html: ownerHtml,
          });
          await logOrderMail({
            siteKey, ownerEmail, sessionId: session.id,
            eventType: event.type, sent: true,
          });
        } catch (e) {
          console.error("❌ sendMail(owner) failed:", safeErr(e));
          await logOrderMail({
            siteKey, ownerEmail, sessionId: session.id,
            eventType: event.type, sent: false,
            reason: `sendMail(owner) failed: ${safeErr(e)}`,
          });
        }
      } else {
        await logOrderMail({
          siteKey, ownerEmail: null, sessionId: session.id,
          eventType: event.type, sent: false,
          reason: `ownerEmail not found at siteSettings/${siteKey}`,
        });
      }
    } else {
      await logOrderMail({
        siteKey: null, ownerEmail: null, sessionId: session.id,
        eventType: event.type, sent: false,
        reason: "siteKey unresolved",
        extras: { connectedAccountId, customerId, metadata: session.metadata ?? null },
      });
    }

    /* F) 購入者宛（多言語） */
    try {
      const buyerEmail = session.customer_details?.email || session.customer_email || null;
      if (buyerEmail) {
        const buyerMail = buildBuyerHtmlI18n(buyerLang, session, items);
        await sendMail({ to: buyerEmail, subject: buyerMail.subject, html: buyerMail.html });
      }
    } catch (e) {
      console.error("❌ sendMail(buyer) failed:", safeErr(e));
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("🔥 webhook handler error:", safeErr(err));
    await logOrderMail({
      siteKey: (event.data.object as any)?.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: (event.data.object as any)?.id ?? null,
      eventType: event.type,
      sent: false,
      reason: `handler error: ${safeErr(err)}`,
    });
    return new Response("OK", { status: 200 });
  }
}
