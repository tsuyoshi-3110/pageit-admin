// app/api/stripe/webhook/route.ts
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { stripeConnect } from "@/lib/stripe-connect";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ----------------------------- Utils ----------------------------- */
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

const PAYOUT_HOLD_MINUTES = Number(process.env.PAYOUT_HOLD_MINUTES ?? "");
const ZERO_DEC = new Set([
  "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf",
]);
const toMajor = (n: number | null | undefined, cur?: string | null) =>
  ZERO_DEC.has((cur ?? "jpy").toLowerCase()) ? n ?? 0 : (n ?? 0) / 100;

const safeErr = (e: unknown) => {
  try {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
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

async function findSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb.collection("siteSettings").where("stripeCustomerId", "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}
async function findSiteKeyByConnectAccount(connectAccountId: string): Promise<string | null> {
  const snap = await adminDb.collection("siteSellers").where("stripe.connectAccountId", "==", connectAccountId).limit(1).get();
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

/* --------------------------- Language --------------------------- */
type LangKey =
  | "ja" | "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR" | "ko" | "zh" | "zh-TW" | "ru" | "th" | "vi" | "id";

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

/* ----------------------------- i18n ----------------------------- */
const buyerText: Record<LangKey, {
  subject: string; heading: string; orderId: string; payment: string; buyer: string;
  table: { name: string; unit: string; qty: string; subtotal: string };
  total: string; shipTo: string; name: string; phone: string; address: string; footer: string;
}> = {
  ja: { subject:"ご購入ありがとうございます（レシート）", heading:"ご注文ありがとうございます", orderId:"注文ID", payment:"支払い", buyer:"購入者",
    table:{ name:"商品名", unit:"単価", qty:"数量", subtotal:"小計" }, total:"合計", shipTo:"お届け先", name:"氏名", phone:"電話", address:"住所",
    footer:"このメールは Stripe Webhook により自動送信されています。" },
  en: { subject:"Thanks for your purchase (receipt)", heading:"Thank you for your order", orderId:"Order ID", payment:"Payment", buyer:"Buyer",
    table:{ name:"Item", unit:"Unit price", qty:"Qty", subtotal:"Subtotal" }, total:"Total", shipTo:"Shipping address", name:"Name", phone:"Phone", address:"Address",
    footer:"This email was sent automatically by Stripe Webhook." },
  // …他言語は省略せず元のまま（ここでは割愛。必要ならそのまま残してください）
  fr:{subject:"Merci pour votre achat (reçu)",heading:"Merci pour votre commande",orderId:"ID de commande",payment:"Paiement",buyer:"Acheteur",
    table:{name:"Article",unit:"Prix unitaire",qty:"Qté",subtotal:"Sous-total"},total:"Total",shipTo:"Adresse de livraison",name:"Nom",phone:"Téléphone",address:"Adresse",
    footer:"Cet e-mail a été sent automatiquement par Stripe Webhook."},
  es:{subject:"Gracias por su compra (recibo)",heading:"Gracias por su pedido",orderId:"ID de pedido",payment:"Pago",buyer:"Comprador",
    table:{name:"Producto",unit:"Precio unitario",qty:"Cant.",subtotal:"Subtotal"},total:"Total",shipTo:"Dirección de envío",name:"Nombre",phone:"Teléfono",address:"Dirección",
    footer:"Este correo fue enviado automáticamente por Stripe Webhook."},
  de:{subject:"Vielen Dank für Ihren Einkauf (Beleg)",heading:"Danke für Ihre Bestellung",orderId:"Bestell-ID",payment:"Zahlung",buyer:"Käufer",
    table:{name:"Artikel",unit:"Einzelpreis",qty:"Menge",subtotal:"Zwischensumme"},total:"Gesamt",shipTo:"Lieferadresse",name:"Name",phone:"Telefon",address:"Adresse",
    footer:"Diese E-Mail wurde automatisch vom Stripe Webhook gesendet."},
  it:{subject:"Grazie per l'acquisto (ricevuta)",heading:"Grazie per il tuo ordine",orderId:"ID ordine",payment:"Pagamento",buyer:"Acquirente",
    table:{name:"Articolo",unit:"Prezzo unitario",qty:"Qtà",subtotal:"Subtotale"},total:"Totale",shipTo:"Indirizzo di spedizione",name:"Nome",phone:"Telefono",address:"Indirizzo",
    footer:"Questa e-mail è stata inviata automaticamente dal webhook di Stripe."},
  pt:{subject:"Obrigado pela compra (recibo)",heading:"Obrigado pelo seu pedido",orderId:"ID do pedido",payment:"Pagamento",buyer:"Comprador",
    table:{name:"Item",unit:"Preço unitário",qty:"Qtd",subtotal:"Subtotal"},total:"Total",shipTo:"Endereço de entrega",name:"Nome",phone:"Telefone",address:"Endereço",
    footer:"Este e-mail foi enviado automaticamente pelo Stripe Webhook."},
  "pt-BR":{subject:"Obrigado pela compra (recibo)",heading:"Obrigado pelo seu pedido",orderId:"ID do pedido",payment:"Pagamento",buyer:"Comprador",
    table:{name:"Item",unit:"Preço unitário",qty:"Qtd",subtotal:"Subtotal"},total:"Total",shipTo:"Endereço de entrega",name:"Nome",phone:"Telefone",address:"Endereço",
    footer:"Este e-mail foi enviado automaticamente pelo Stripe Webhook."},
  ko:{subject:"구매해 주셔서 감사합니다 (영수증)",heading:"주문해 주셔서 감사합니다",orderId:"주문 ID",payment:"결제",buyer:"구매자",
    table:{name:"상품명",unit:"단가",qty:"수량",subtotal:"소계"},total:"합계",shipTo:"배송지",name:"이름",phone:"전화",address:"주소",
    footer:"이 메일은 Stripe Webhook에 의해 자동 전송되었습니다."},
  zh:{subject:"感谢您的购买（收据）",heading:"感谢您的订单",orderId:"订单编号",payment:"支付",buyer:"购买者",
    table:{name:"商品名称",unit:"单价",qty:"数量",subtotal:"小计"},total:"合计",shipTo:"收货地址",name:"姓名",phone:"电话",address:"地址",
    footer:"此邮件由 Stripe Webhook 自动发送。"},
  "zh-TW":{subject:"感謝您的購買（收據）",heading:"感謝您的訂單",orderId:"訂單編號",payment:"付款",buyer:"購買者",
    table:{name:"商品名稱",unit:"單價",qty:"數量",subtotal:"小計"},total:"合計",shipTo:"收件地址",name:"姓名",phone:"電話",address:"地址",
    footer:"此郵件由 Stripe Webhook 自動發送。"},
  ru:{subject:"Спасибо за покупку (квитанция)",heading:"Спасибо за ваш заказ",orderId:"ID заказа",payment:"Оплата",buyer:"Покупатель",
    table:{name:"Товар",unit:"Цена",qty:"Кол-во",subtotal:"Промежуточный итог"},total:"Итого",shipTo:"Адрес доставки",name:"Имя",phone:"Телефон",address:"Адрес",
    footer:"Это письмо отправлено автоматически через Stripe Webhook."},
  th:{subject:"ขอบคุณสำหรับการสั่งซื้อ (ใบเสร็จ)",heading:"ขอบคุณสำหรับคำสั่งซื้อ",orderId:"รหัสคำสั่งซื้อ",payment:"การชำระเงิน",buyer:"ผู้ซื้อ",
    table:{name:"สินค้า",unit:"ราคาต่อหน่วย",qty:"จำนวน",subtotal:"ยอดย่อย"},total:"ยอดรวม",shipTo:"ที่อยู่จัดส่ง",name:"ชื่อ",phone:"โทร",address:"ที่อยู่",
    footer:"อีเมลนี้ถูกส่งโดยอัตโนมัติจาก Stripe Webhook"},
  vi:{subject:"Cảm ơn bạn đã mua hàng (biên nhận)",heading:"Cảm ơn bạn đã đặt hàng",orderId:"Mã đơn hàng",payment:"Thanh toán",buyer:"Người mua",
    table:{name:"Sản phẩm",unit:"Đơn giá",qty:"SL",subtotal:"Tạm tính"},total:"Tổng",shipTo:"Địa chỉ giao hàng",name:"Tên",phone:"Điện thoại",address:"Địa chỉ",
    footer:"Email này được gửi tự động bởi Stripe Webhook."},
  id:{subject:"Terima kasih atas pembelian Anda (kwitansi)",heading:"Terima kasih atas pesanan Anda",orderId:"ID Pesanan",payment:"Pembayaran",buyer:"Pembeli",
    table:{name:"Produk",unit:"Harga satuan",qty:"Jml",subtotal:"Subtotal"},total:"Total",shipTo:"Alamat pengiriman",name:"Nama",phone:"Telepon",address:"Alamat",
    footer:"Email ini dikirim otomatis oleh Stripe Webhook."},
};

/* ------------------------- 明細生成ロジック ------------------------- */
type MailItem = {
  names: Partial<Record<LangKey, string>> & { default: string };
  qty: number;
  unitAmount: number;
  subtotal: number;
};
const getName = (mi: MailItem, lang: LangKey): string =>
  mi.names[lang] || mi.names.default;

/** Stripe から line items を取得（フォールバック用） */
async function buildItemsFromStripe(
  session: Stripe.Checkout.Session,
  reqOpts?: Stripe.RequestOptions,
  preferLang: LangKey = "en"
): Promise<MailItem[]> {
  const fetch = (o?: Stripe.RequestOptions) =>
    stripeConnect.checkout.sessions.listLineItems(
      session.id,
      { limit: 100, expand: ["data.price.product"] },
      o
    );

  let scope: "connected" | "platform" = reqOpts ? "connected" : "platform";
  let li = reqOpts ? await fetch(reqOpts) : await fetch();

  const notExpanded = li.data.some((d) => typeof d.price?.product === "string");
  if (notExpanded) {
    li = reqOpts ? await fetch() : await fetch(reqOpts);
    scope = scope === "connected" ? "platform" : "connected";
  }
  console.log("[webhook] listLineItems scope:", scope, "count:", li.data.length);

  const langs: LangKey[] = ["ja","en","fr","es","de","it","pt","pt-BR","ko","zh","zh-TW","ru","th","vi","id"];
  const base = preferLang.split("-")[0] as LangKey;

  return li.data.map((x) => {
    const prod = typeof x.price?.product === "string" ? undefined : (x.price?.product as Stripe.Product);
    const md = (prod?.metadata ?? {}) as Record<string, string>;
    const desc = (x.description || "").trim();

    const metaPrefer = md[`name_${preferLang}`] || md[`name_${base}`] || md.name;
    const defaultName = desc || metaPrefer || prod?.name || "Item";

    const names: MailItem["names"] = { default: defaultName };
    for (const lk of langs) {
      const v = md[`name_${lk}`];
      if (typeof v === "string" && v.trim()) names[lk] = v.trim();
    }
    if (!names.ja) names.ja = defaultName;
    if (!names.en) names.en = defaultName;

    const qty = x.quantity ?? 1;
    const subMajor = toMajor(x.amount_subtotal ?? x.amount_total ?? 0, session.currency);
    const unitMajor = subMajor / Math.max(1, qty);

    return { names, qty, unitAmount: unitMajor, subtotal: subMajor };
  });
}

/* ----------------------------- HTML ----------------------------- */
// buildOwnerHtmlJa / buildBuyerHtmlI18n は元の実装のまま（長いので割愛せずに利用）
function buildOwnerHtmlJa(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: MailItem[]
) {
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = "ja-JP";
  const ship = (session as any).shipping_details as any;
  const cust = session.customer_details;
  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;
  const addr = [
    addrObj?.postal_code ? `〒${addrObj.postal_code}` : "",
    addrObj?.state, addrObj?.city, addrObj?.line1, addrObj?.line2,
    addrObj?.country && addrObj?.country !== "JP" ? addrObj.country : "",
  ].filter(Boolean).join(" ");
  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);
  const rows = items.map((it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(it,"ja")}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.unitAmount,cur,locale)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.subtotal,cur,locale)}</td>
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

function buildBuyerHtmlI18n(
  lang: LangKey,
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: MailItem[]
) {
  const t = buyerText[lang] || buyerText.en;
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = LOCALE_BY_LANG[lang] || "en";
  const ship = (session as any).shipping_details as any;
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
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(it,lang)}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.unitAmount,cur,locale)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(it.subtotal,cur,locale)}</td>
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
      <p style="margin-top:12px;"><b>${t.total}: ${fmtCur(total,cur,locale)}</b></p>
      <h3>${t.shipTo}</h3>
      <p>${t.name}: ${name}<br/>${t.phone}: ${phone}<br/>${t.address}: ${addr || "-"}</p>
      <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
      <p style="color:#666;font-size:12px;">${t.footer}</p>
    </div>`,
  };
}

/* ----------------------------- Webhook ----------------------------- */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    console.error("⚠️ Missing stripe-signature header");
    await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: null, eventType: "missing_signature", sent: false, reason: "stripe-signature header missing" });
    return new Response("OK", { status: 200 });
  }

  let event: Stripe.Event;
  try {
    event = stripeConnect.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", safeErr(err));
    await logOrderMail({ siteKey: null, ownerEmail: null, sessionId: null, eventType: "signature_error", sent: false, reason: `signature error: ${safeErr(err)}` });
    return new Response("OK", { status: 200 });
  }

  // ---- 冪等ガード（再送でも二重処理しない）----
  const eventRef = adminDb.collection("stripeEvents").doc(event.id);
  const eventSnap = await eventRef.get();
  if (eventSnap.exists) return new Response("OK", { status: 200 });

  if (event.type !== "checkout.session.completed") {
    await eventRef.set({ type: event.type, created: new Date(), skipped: true });
    return new Response("OK", { status: 200 });
  }

  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts: Stripe.RequestOptions | undefined = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string; lang?: string; uiLang?: string; transferGroup?: string; sellerConnectId?: string; platformFeePct?: string; };
    shipping_details?: ShippingDetails;
  };

  try {
    /* 0) pendingOrders を取得（在庫減算の正） */
    const pendingRef = adminDb.collection("pendingOrders").doc(session.id);
    const pendingSnap = await pendingRef.get();

    let siteKeyFromPending: string | null = null;
    let pendingItems: Array<{ id: string; name?: string; quantity: number }> = [];

    if (pendingSnap.exists) {
      const p = pendingSnap.data() as any;
      siteKeyFromPending = p.siteKey || null;
      pendingItems = Array.isArray(p.items)
        ? p.items.map((x: any) => ({ id: String(x.id), name: x.name, quantity: Number(x.quantity || 0) }))
        : [];
    }

    /* A) PaymentIntent / 決済手段 */
    let pi: Stripe.PaymentIntent | null = null;
    try {
      try {
        pi = await stripeConnect.paymentIntents.retrieve(session.payment_intent as string, { expand: ["latest_charge"] });
      } catch {
        pi = await stripeConnect.paymentIntents.retrieve(session.payment_intent as string, { expand: ["latest_charge"] }, reqOpts);
      }
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

    /* B) 明細（メール用） */
    const buyerLang = normalizeLang(
      session.metadata?.lang || session.metadata?.uiLang || (session.locale as any) || "en"
    );

    let items: MailItem[] = [];
    try {
      items = await buildItemsFromStripe(session, reqOpts, buyerLang);
    } catch (e) {
      console.error("❌ listLineItems failed:", safeErr(e));
      const totalMajor = toMajor(session.amount_total, session.currency);
      items = [{ names: { default: "Item" }, qty: 1, unitAmount: totalMajor, subtotal: totalMajor }];
    }

    /* C) siteKey 解決（pending優先 → metadata → account → customer） */
    const customerId = (session.customer as string) || null;
    const siteKey: string | null =
      siteKeyFromPending ??
      session.metadata?.siteKey ??
      (connectedAccountId ? await findSiteKeyByConnectAccount(connectedAccountId) : null) ??
      session.client_reference_id ??
      (customerId ? await findSiteKeyByCustomerId(customerId) : null);

    /* D) 🔸 在庫減算（商品ドキュメント + stock 両方、トランザクション） */
    const { FieldValue } = await import("firebase-admin/firestore");

    const li = await stripeConnect.checkout.sessions.listLineItems(
      session.id,
      { limit: 100, expand: ["data.price.product"] },
      reqOpts
    );

    await adminDb.runTransaction(async (tx) => {
      // 既に処理済みならスキップ
      const pSnapTx = await tx.get(pendingRef);
      const paidAlready = pSnapTx.exists && pSnapTx.get("status") === "paid";
      if (paidAlready) {
        tx.set(eventRef, { type: event.type, created: new Date(), sessionId: session.id, idempotent: true });
        return;
      }

      // 減算対象（pending 優先 → Stripe line items）
      let decList: Array<{ id: string; qty: number }> = [];
      if (pendingItems.length > 0) {
        decList = pendingItems.map((x) => ({ id: x.id, qty: Math.max(0, Number(x.quantity || 0)) }));
      } else if (siteKey) {
        decList = li.data
          .map((x) => {
            const prod = typeof x.price?.product === "string" ? undefined : (x.price?.product as Stripe.Product);
            const pid = (prod?.metadata as any)?.productId as string | undefined;
            const qty = x.quantity ?? 0;
            return pid ? { id: pid, qty: Math.max(0, qty) } : null;
          })
          .filter(Boolean) as any[];
      }

      if (siteKey && decList.length > 0) {
        for (const row of decList) {
          const stockId = `${siteKey}__p:${row.id}`;
          const stockRef = adminDb.collection("stock").doc(stockId);
          const prodRef  = adminDb.doc(`siteProducts/${siteKey}/items/${row.id}`);

          const [sSnap, pSnap] = await Promise.all([tx.get(stockRef), tx.get(prodRef)]);

          // 現在庫の取得（product doc 優先→stock doc→0）
          const readFromProduct = () => {
            if (!pSnap.exists) return null;
            const d = pSnap.data() as any;
            const cands = [d?.stockQty, d?.stock, d?.inventory?.stockQty];
            const v = cands.find((x) => Number.isFinite(Number(x)));
            return Number.isFinite(Number(v)) ? Number(v) : null;
          };
          let before =
            readFromProduct() ??
            (sSnap.exists ? Number(sSnap.get("stockQty") ?? 0) : null);
          if (!Number.isFinite(before as number)) before = 0;

          const after = Math.max(0, (before as number) - row.qty);

          // product doc の更新（存在すれば）
          if (pSnap.exists) {
            const d = pSnap.data() as any;
            const update: any = { updatedAt: FieldValue.serverTimestamp() };
            if (typeof d?.stockQty !== "undefined") update.stockQty = after;
            else if (typeof d?.stock !== "undefined") update.stock = after;
            else update["inventory.stockQty"] = after;
            tx.update(prodRef, update);
          }

          // stock コレクションも同期
          if (sSnap.exists) {
            tx.update(stockRef, { stockQty: after, updatedAt: new Date() });
          } else {
            tx.set(stockRef, {
              id: stockId,
              siteKey,
              productId: row.id,
              sku: null,
              name: null,
              stockQty: after,
              lowStockThreshold: 0,
              updatedAt: new Date(),
            });
          }

          // 調整ログ
          const logRef = adminDb.collection("stockAdjustments").doc();
          tx.set(logRef, {
            siteKey,
            stockId,
            sku: sSnap.exists ? sSnap.get("sku") ?? null : null,
            delta: after - (before as number), // 負数
            type: "decrement",
            reason: "sale",
            beforeQty: before,
            afterQty: after,
            createdAt: new Date(),
          });
        }
      }

      // pending の状態更新
      if (pSnapTx.exists) {
        tx.update(pendingRef, {
          status: "paid",
          paidAt: new Date(),
          sessionSummary: {
            amount_total: session.amount_total ?? null,
            currency: session.currency ?? "jpy",
            payment_status: session.payment_status,
          },
        });
      }

      // 冪等マーク
      tx.set(eventRef, { type: event.type, created: new Date(), sessionId: session.id });
    });

    /* E) siteOrders 保存 */
    await adminDb.collection("siteOrders").add({
      siteKey: siteKey || null,
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
        address: session.customer_details?.address ?? (session as any).shipping_details?.address ?? null,
      },
      items: items.map((i) => ({
        name: i.names[buyerLang] ?? i.names.ja ?? i.names.default,
        qty: i.qty,
        unitAmount: i.unitAmount,
        subtotal: i.subtotal,
      })),
      buyer_lang: buyerLang,
    });

    /* F) stripeCustomerId の保存（将来の参照用） */
    const customerIdResolved = (session.customer as string) || null;
    if (siteKey && customerIdResolved) {
      await adminDb.doc(`siteSettings/${siteKey}`).set({ stripeCustomerId: customerIdResolved }, { merge: true });
    }

    async function resolveHoldMs(siteKey: string | null): Promise<number> {
      try {
        if (siteKey) {
          const s = await adminDb.doc(`siteSellers/${siteKey}`).get();
          const min = Number(s.get("testHoldMinutes"));
          if (Number.isFinite(min) && min >= 0) return min * 60 * 1000;
          const sec = Number(s.get("testHoldSeconds"));
          if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
        }
      } catch {}
      try {
        const g = await adminDb.doc("adminSettings/global").get();
        const min = Number(g.get("payoutHoldMinutes"));
        if (Number.isFinite(min) && min >= 0) return min * 60 * 1000;
        const sec = Number(g.get("payoutHoldSeconds"));
        if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
        const days = Number(g.get("payoutHoldDays"));
        if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
      } catch {}
      try {
        const p = await adminDb.doc("platformConfig/payouts").get();
        const days = Number(p.get("holdDays"));
        if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
      } catch {}
      const envMin = Number(PAYOUT_HOLD_MINUTES);
      if (Number.isFinite(envMin) && envMin >= 0) return envMin * 60 * 1000;
      return 30 * 24 * 60 * 60 * 1000;
    }

    /* G) 🔸 エスクロー記録 */
    const DEFAULT_PLATFORM_FEE_RATE = 0.07;
    const holdMs = await resolveHoldMs(siteKey || null);
    const now = new Date();
    const releaseAt = new Date(now.getTime() + holdMs);

    const transferGroup = session.metadata?.transferGroup || null;
    const sellerConnectIdEscrow = session.metadata?.sellerConnectId || connectedAccountId || null;

    const gross = session.amount_total ?? 0;
    const pctMeta = session.metadata?.platformFeePct;
    const feeRate = Number.isFinite(Number(pctMeta)) ? Number(pctMeta) : DEFAULT_PLATFORM_FEE_RATE;
    const platformFee = Math.floor(gross * feeRate);
    const sellerAmount = Math.max(0, gross - platformFee);

    const currency = (session.currency || "jpy").toLowerCase();
    const chargeId = (pi?.latest_charge as Stripe.Charge | undefined)?.id || null;

    await adminDb.collection("escrows").doc(session.id).set({
      siteKey: siteKey || null,
      sessionId: session.id,
      currency,
      gross,
      platformFee,
      sellerAmount,
      sellerConnectId: sellerConnectIdEscrow,
      transferGroup,
      status: "held",
      paymentIntentId: pi?.id || null,
      chargeId,
      manualHold: false,
      createdAt: now,
      releaseAt,
    });

    /* H) オーナー宛（日本語固定） */
    if (siteKey) {
      const ownerEmail = await getOwnerEmail(siteKey);
      if (ownerEmail) {
        const ownerHtml = buildOwnerHtmlJa(session, items);
        try {
          await sendMail({ to: ownerEmail, subject: "【注文通知】新しい注文が完了しました", html: ownerHtml });
          await logOrderMail({ siteKey, ownerEmail, sessionId: session.id, eventType: event.type, sent: true });
        } catch (e) {
          console.error("❌ sendMail(owner) failed:", safeErr(e));
          await logOrderMail({ siteKey, ownerEmail, sessionId: session.id, eventType: event.type, sent: false, reason: `sendMail(owner) failed: ${safeErr(e)}` });
        }
      } else {
        await logOrderMail({ siteKey, ownerEmail: null, sessionId: session.id, eventType: event.type, sent: false, reason: `ownerEmail not found at siteSettings/${siteKey}` });
      }
    } else {
      await logOrderMail({
        siteKey: null, ownerEmail: null, sessionId: session.id, eventType: event.type, sent: false,
        reason: "siteKey unresolved",
        extras: { connectedAccountId, customerId: session.customer, metadata: session.metadata ?? null },
      });
    }

    /* I) 購入者宛（多言語レシート） */
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
    await eventRef.set({ type: event.type, created: new Date(), errored: true, reason: safeErr(err) }, { merge: true });
    await logOrderMail({
      siteKey: (event.data.object as any)?.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: (event.data.object as any)?.id ?? null,
      eventType: event.type,
      sent: false,
      reason: `handler error: ${safeErr(err)}`,
    });
    // Stripe の過剰リトライを避けるため 200 を返す
    return new Response("OK", { status: 200 });
  }
}
