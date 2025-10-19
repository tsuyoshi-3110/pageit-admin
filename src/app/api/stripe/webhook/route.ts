// app/api/stripe/webhook/route.ts（管理ウェブ側）
import { stripe } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------- 型・ユーティリティ -------------------- */
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
  } catch {
    return String(e);
  }
};

const fmtJPY = (n: number) => `¥${Math.round(n).toLocaleString()}`;

/* -------------------- Firestore helpers -------------------- */
async function findSiteKeyByCustomerId(customerId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function findSiteKeyByConnectAccount(connectAccountId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSellers")
    .where("stripe.connectAccountId", "==", connectAccountId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id; // ドキュメントID=siteKey 前提
}

async function getOwnerEmail(siteKey: string): Promise<string | null> {
  const doc = await adminDb.doc(`siteSettings/${siteKey}`).get();
  const email = doc.get("ownerEmail");
  return typeof email === "string" ? email : null;
}

async function logOrderMail(rec: {
  siteKey: string | null;
  ownerEmail: string | null;
  sessionId: string;
  eventType: string;
  sent: boolean;
  reason?: string | null;
  extras?: Record<string, unknown>;
}) {
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("orderMails").add({
    ...rec,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* -------------------- 言語判定 -------------------- */
type LangKey =
  | "ja" | "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR" | "ko"
  | "zh" | "zh-TW" | "ru" | "th" | "vi" | "id";

function normalizeLang(input?: string | null): LangKey {
  const v = (input || "").toLowerCase();
  if (!v) return "en";
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("es-419")) return "es"; // まとめて es
  if (v.startsWith("es")) return "es";
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

/* -------------------- 購入者向け 多言語テキスト -------------------- */
const buyerText: Record<LangKey, {
  subject: string;
  heading: string;
  orderId: string;
  payment: string;
  buyer: string;
  table: { name: string; unit: string; qty: string; subtotal: string; };
  total: (amount: number, cur: string) => string;
  shipTo: string;
  name: string;
  phone: string;
  address: string;
  footer: string;
}> = {
  ja: {
    subject: "ご購入ありがとうございます（ご注文のレシート）",
    heading: "ご注文ありがとうございます",
    orderId: "注文ID",
    payment: "支払い",
    buyer: "購入者",
    table: { name: "商品名", unit: "単価（税込）", qty: "数量", subtotal: "小計" },
    total: (a, c) => `合計: ${fmtJPY(a)}（${c.toUpperCase()}）`,
    shipTo: "お届け先",
    name: "氏名",
    phone: "電話",
    address: "住所",
    footer: "このメールは Stripe Webhook により自動送信されています。",
  },
  en: {
    subject: "Thanks for your purchase (receipt)",
    heading: "Thank you for your order",
    orderId: "Order ID",
    payment: "Payment",
    buyer: "Buyer",
    table: { name: "Item", unit: "Unit price (tax incl.)", qty: "Qty", subtotal: "Subtotal" },
    total: (a, c) => `Total: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Shipping address",
    name: "Name",
    phone: "Phone",
    address: "Address",
    footer: "This email was sent automatically by Stripe Webhook.",
  },
  fr: {
    subject: "Merci pour votre achat (reçu)",
    heading: "Merci pour votre commande",
    orderId: "ID de commande",
    payment: "Paiement",
    buyer: "Acheteur",
    table: { name: "Article", unit: "Prix unitaire (TTC)", qty: "Qté", subtotal: "Sous-total" },
    total: (a, c) => `Total : ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Adresse de livraison",
    name: "Nom",
    phone: "Téléphone",
    address: "Adresse",
    footer: "Cet e-mail a été envoyé automatiquement par Stripe Webhook.",
  },
  es: {
    subject: "Gracias por su compra (recibo)",
    heading: "Gracias por su pedido",
    orderId: "ID de pedido",
    payment: "Pago",
    buyer: "Comprador",
    table: { name: "Producto", unit: "Precio unitario (IVA incl.)", qty: "Cant.", subtotal: "Subtotal" },
    total: (a, c) => `Total: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Dirección de envío",
    name: "Nombre",
    phone: "Teléfono",
    address: "Dirección",
    footer: "Este correo fue enviado automáticamente por Stripe Webhook.",
  },
  de: {
    subject: "Vielen Dank für Ihren Einkauf (Beleg)",
    heading: "Danke für Ihre Bestellung",
    orderId: "Bestell-ID",
    payment: "Zahlung",
    buyer: "Käufer",
    table: { name: "Artikel", unit: "Einzelpreis (inkl. MwSt.)", qty: "Menge", subtotal: "Zwischensumme" },
    total: (a, c) => `Gesamt: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Lieferadresse",
    name: "Name",
    phone: "Telefon",
    address: "Adresse",
    footer: "Diese E-Mail wurde automatisch vom Stripe Webhook gesendet.",
  },
  it: {
    subject: "Grazie per l'acquisto (ricevuta)",
    heading: "Grazie per il tuo ordine",
    orderId: "ID ordine",
    payment: "Pagamento",
    buyer: "Acquirente",
    table: { name: "Articolo", unit: "Prezzo unitario (IVA incl.)", qty: "Qtà", subtotal: "Subtotale" },
    total: (a, c) => `Totale: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Indirizzo di spedizione",
    name: "Nome",
    phone: "Telefono",
    address: "Indirizzo",
    footer: "Questa e-mail è stata inviata automaticamente dal webhook di Stripe.",
  },
  pt: {
    subject: "Obrigado pela compra (recibo)",
    heading: "Obrigado pelo seu pedido",
    orderId: "ID do pedido",
    payment: "Pagamento",
    buyer: "Comprador",
    table: { name: "Item", unit: "Preço unit. (c/ imposto)", qty: "Qtd", subtotal: "Subtotal" },
    total: (a, c) => `Total: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Endereço de entrega",
    name: "Nome",
    phone: "Telefone",
    address: "Endereço",
    footer: "Este e-mail foi enviado automaticamente pelo Stripe Webhook.",
  },
  "pt-BR": {
    subject: "Obrigado pela compra (recibo)",
    heading: "Obrigado pelo seu pedido",
    orderId: "ID do pedido",
    payment: "Pagamento",
    buyer: "Comprador",
    table: { name: "Item", unit: "Preço unit. (c/ imposto)", qty: "Qtd", subtotal: "Subtotal" },
    total: (a, c) => `Total: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Endereço de entrega",
    name: "Nome",
    phone: "Telefone",
    address: "Endereço",
    footer: "Este e-mail foi enviado automaticamente pelo Stripe Webhook.",
  },
  ko: {
    subject: "구매해 주셔서 감사합니다 (영수증)",
    heading: "주문해 주셔서 감사합니다",
    orderId: "주문 ID",
    payment: "결제",
    buyer: "구매자",
    table: { name: "상품명", unit: "단가(세금 포함)", qty: "수량", subtotal: "소계" },
    total: (a, c) => `합계: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "배송지",
    name: "이름",
    phone: "전화",
    address: "주소",
    footer: "이 메일은 Stripe Webhook에 의해 자동 전송되었습니다.",
  },
  zh: {
    subject: "感谢您的购买（收据）",
    heading: "感谢您的订单",
    orderId: "订单编号",
    payment: "支付",
    buyer: "购买者",
    table: { name: "商品名称", unit: "单价（含税）", qty: "数量", subtotal: "小计" },
    total: (a, c) => `合计：${fmtJPY(a)}（${c.toUpperCase()}）`,
    shipTo: "收货地址",
    name: "姓名",
    phone: "电话",
    address: "地址",
    footer: "此邮件由 Stripe Webhook 自动发送。",
  },
  "zh-TW": {
    subject: "感謝您的購買（收據）",
    heading: "感謝您的訂單",
    orderId: "訂單編號",
    payment: "付款",
    buyer: "購買者",
    table: { name: "商品名稱", unit: "單價（含稅）", qty: "數量", subtotal: "小計" },
    total: (a, c) => `合計：${fmtJPY(a)}（${c.toUpperCase()}）`,
    shipTo: "收件地址",
    name: "姓名",
    phone: "電話",
    address: "地址",
    footer: "此郵件由 Stripe Webhook 自動發送。",
  },
  ru: {
    subject: "Спасибо за покупку (квитанция)",
    heading: "Спасибо за ваш заказ",
    orderId: "ID заказа",
    payment: "Оплата",
    buyer: "Покупатель",
    table: { name: "Товар", unit: "Цена (с налогом)", qty: "Кол-во", subtotal: "Промежуточный итог" },
    total: (a, c) => `Итого: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Адрес доставки",
    name: "Имя",
    phone: "Телефон",
    address: "Адрес",
    footer: "Это письмо отправлено автоматически через Stripe Webhook.",
  },
  th: {
    subject: "ขอบคุณสำหรับการสั่งซื้อ (ใบเสร็จ)",
    heading: "ขอบคุณสำหรับคำสั่งซื้อ",
    orderId: "รหัสคำสั่งซื้อ",
    payment: "การชำระเงิน",
    buyer: "ผู้ซื้อ",
    table: { name: "สินค้า", unit: "ราคาต่อหน่วย (รวมภาษี)", qty: "จำนวน", subtotal: "ยอดย่อย" },
    total: (a, c) => `ยอดรวม: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "ที่อยู่จัดส่ง",
    name: "ชื่อ",
    phone: "โทร",
    address: "ที่อยู่",
    footer: "อีเมลนี้ถูกส่งโดยอัตโนมัติจาก Stripe Webhook",
  },
  vi: {
    subject: "Cảm ơn bạn đã mua hàng (biên nhận)",
    heading: "Cảm ơn bạn đã đặt hàng",
    orderId: "Mã đơn hàng",
    payment: "Thanh toán",
    buyer: "Người mua",
    table: { name: "Sản phẩm", unit: "Đơn giá (đã gồm thuế)", qty: "SL", subtotal: "Tạm tính" },
    total: (a, c) => `Tổng: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Địa chỉ giao hàng",
    name: "Tên",
    phone: "Điện thoại",
    address: "Địa chỉ",
    footer: "Email này được gửi tự động bởi Stripe Webhook.",
  },
  id: {
    subject: "Terima kasih atas pembelian Anda (kwitansi)",
    heading: "Terima kasih atas pesanan Anda",
    orderId: "ID Pesanan",
    payment: "Pembayaran",
    buyer: "Pembeli",
    table: { name: "Produk", unit: "Harga satuan (termasuk pajak)", qty: "Jml", subtotal: "Subtotal" },
    total: (a, c) => `Total: ${fmtJPY(a)} (${c.toUpperCase()})`,
    shipTo: "Alamat pengiriman",
    name: "Nama",
    phone: "Telepon",
    address: "Alamat",
    footer: "Email ini dikirim otomatis oleh Stripe Webhook.",
  },
};

/* -------------------- メールHTML（オーナー：日本語固定） -------------------- */
function buildOwnerHtmlJa(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }>
) {
  const cur = (session.currency || "jpy").toUpperCase();

  const ship = (session as any).shipping_details as
    | { name?: string | null; phone?: string | null; address?: Stripe.Address | null }
    | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;

  const addr = [
    addrObj?.postal_code ? `〒${addrObj.postal_code}` : "",
    addrObj?.state,
    addrObj?.city,
    addrObj?.line1,
    addrObj?.line2,
    addrObj?.country && addrObj.country !== "JP" ? addrObj.country : "",
  ]
    .filter(Boolean)
    .join(" ");

  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items
    .map((it) => {
      const unit = it.unitAmount;
      const sub = typeof it.subtotal === "number" ? it.subtotal : unit * it.qty;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${it.name}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtJPY(unit)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtJPY(sub)}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b>／支払い: <b>${session.payment_status}</b></p>
    <p>購入者: <b>${buyer}</b></p>
    <table style="border-collapse:collapse;width:100%;max-width:680px;">
      <thead><tr>
        <th style="text-align:left;border-bottom:2px solid #333;">商品名</th>
        <th style="text-align:right;border-bottom:2px solid #333;">単価（税込）</th>
        <th style="text-align:center;border-bottom:2px solid #333;">数量</th>
        <th style="text-align:right;border-bottom:2px solid #333;">小計</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:12px;">合計: <b>${fmtJPY(total)}</b> (${cur})</p>
    <h3>お届け先</h3>
    <p>氏名：${name}<br/>電話：${phone}<br/>住所：${addr || "-"}</p>
    <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
    <p style="color:#666;font-size:12px;">このメールは Stripe Webhook により自動送信されています。</p>
  </div>`;
}

/* -------------------- メールHTML（購入者：多言語） -------------------- */
function buildBuyerHtmlI18n(
  lang: LangKey,
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }>
) {
  const t = buyerText[lang] || buyerText.en;
  const cur = (session.currency || "jpy").toUpperCase();

  const ship = (session as any).shipping_details as
    | { name?: string | null; phone?: string | null; address?: Stripe.Address | null }
    | undefined;
  const cust = session.customer_details;

  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined = ship?.address ?? cust?.address ?? undefined;

  const addr = [
    addrObj?.postal_code,
    addrObj?.state,
    addrObj?.city,
    addrObj?.line1,
    addrObj?.line2,
    addrObj?.country && addrObj.country !== "JP" ? addrObj.country : "",
  ]
    .filter(Boolean)
    .join(" ");

  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);

  const rows = items
    .map((it) => {
      const unit = it.unitAmount;
      const sub = typeof it.subtotal === "number" ? it.subtotal : unit * it.qty;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${it.name}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtJPY(unit)}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${it.qty}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtJPY(sub)}</td>
      </tr>`;
    })
    .join("");

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
      <p style="margin-top:12px;"><b>${t.total(total, cur)}</b></p>
      <h3>${t.shipTo}</h3>
      <p>${t.name}: ${name}<br/>${t.phone}: ${phone}<br/>${t.address}: ${addr || "-"}</p>
      <hr style="margin:16px 0;border:0;border-top:1px solid #eee;" />
      <p style="color:#666;font-size:12px;">${t.footer}</p>
    </div>`,
  };
}

/* ============================================================
   Webhook
============================================================ */
export async function POST(req: NextRequest) {
  const rawBody = await req.arrayBuffer();
  const sig = (await headers()).get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature header", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      Buffer.from(rawBody),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", safeErr(err));
    return new Response("Webhook Error", { status: 400 });
  }

  const eventType = event.type;
  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  if (eventType !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: { siteKey?: string; items?: string; uiLang?: string };
    shipping_details?: ShippingDetails;
  };

  try {
    /* ---------- 1) Firestore 保存（電話番号も保存） ---------- */
    const itemsFromMeta: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }> =
      session.metadata?.items ? JSON.parse(session.metadata.items) : [];

    const customerPhone =
      session.customer_details?.phone ??
      (session as any).shipping_details?.phone ??
      null;

    await adminDb.collection("siteOrders").add({
      siteKey: session.metadata?.siteKey || null,
      createdAt: new Date(),
      stripeCheckoutSessionId: session.id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      customer: {
        email: session.customer_details?.email ?? null,
        name: session.customer_details?.name ?? (session as any).shipping_details?.name ?? null,
        phone: customerPhone,
        address:
          session.customer_details?.address ??
          (session as any).shipping_details?.address ??
          null,
      },
      items: itemsFromMeta,
    });

    /* ---------- 2) siteKey 解決 ---------- */
    const customerId = (session.customer as string) || null;
    const siteKey: string | null =
      session.metadata?.siteKey
      ?? (connectedAccountId ? await findSiteKeyByConnectAccount(connectedAccountId) : null)
      ?? session.client_reference_id
      ?? (customerId ? await findSiteKeyByCustomerId(customerId) : null);

    if (!siteKey) {
      await logOrderMail({
        siteKey: null,
        ownerEmail: null,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: "siteKey unresolved",
        extras: { connectedAccountId, customerId, metadata: session.metadata ?? null },
      });
      return new Response("Order saved (no siteKey for mail)", { status: 200 });
    }

    // 初回購入で未保存なら stripeCustomerId を保存
    if (customerId) {
      await adminDb.doc(`siteSettings/${siteKey}`).set({ stripeCustomerId: customerId }, { merge: true });
    }

    /* ---------- 3) ownerEmail 取得 ---------- */
    const ownerEmail = await getOwnerEmail(siteKey);
    if (!ownerEmail) {
      await logOrderMail({
        siteKey,
        ownerEmail: null,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: `ownerEmail not found at siteSettings/${siteKey}`,
      });
      return new Response("Order saved (no ownerEmail)", { status: 200 });
    }

    /* ---------- 4) メール items 準備 ---------- */
    let mailItems: Array<{ name: string; qty: number; unitAmount: number; subtotal?: number }> = itemsFromMeta;

    if (!mailItems.length) {
      try {
        const li = await stripe.checkout.sessions.listLineItems(
          session.id,
          { expand: ["data.price.product"], limit: 100 },
          reqOpts
        );
        // Stripe側の通貨→合計には使うが、行は JPY 固定で表示したい運用ならここでは触らない
        mailItems = li.data.map((x) => {
          const name = (x.price?.product as Stripe.Product | undefined)?.name || x.description || "商品";
          const qty = x.quantity || 1;
          const subtotalMajor = toMajor(x.amount_subtotal ?? x.amount_total ?? 0, session.currency);
          const unit = subtotalMajor / Math.max(1, qty);
          // 行の JPY 表示が不要なら unit/subtotal を Stripe通貨で出す運用に変更可能
          return { name, qty, unitAmount: unit, subtotal: subtotalMajor };
        });
      } catch (e) {
        console.warn("⚠️ listLineItems failed, fallback to minimal:", safeErr(e));
        mailItems = [{ name: "（明細の取得に失敗）", qty: 1, unitAmount: toMajor(session.amount_total, session.currency) }];
      }
    }

    /* ---------- 5) 送信：オーナー（日本語固定） ---------- */
    const ownerHtml = buildOwnerHtmlJa(session, mailItems);
    try {
      await sendMail({
        to: ownerEmail,
        subject: "【注文通知】新しい注文が完了しました",
        html: ownerHtml,
      });
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        eventType,
        sent: true,
      });
    } catch (e) {
      console.error("❌ sendMail (owner) failed:", safeErr(e));
      await logOrderMail({
        siteKey,
        ownerEmail,
        sessionId: session.id,
        eventType,
        sent: false,
        reason: `sendMail(owner) failed: ${safeErr(e)}`,
      });
    }

    /* ---------- 6) 送信：購入者（多言語） ---------- */
    try {
      const buyerEmail =
        session.customer_details?.email || session.customer_email || null;
      if (buyerEmail) {
        // 言語優先度: metadata.uiLang → session.locale → en
        const resolvedLang = normalizeLang(session.metadata?.uiLang || (session.locale as string) || "en");
        const buyerMail = buildBuyerHtmlI18n(resolvedLang, session, mailItems);
        await sendMail({
          to: buyerEmail,
          subject: buyerMail.subject,
          html: buyerMail.html,
        });
      }
    } catch (e) {
      console.error("❌ sendMail (buyer) failed:", safeErr(e));
      // 続行
    }

    return new Response("Order saved & mail handled", { status: 200 });
  } catch (err) {
    console.error("🔥 webhook handler error:", safeErr(err));
    await logOrderMail({
      siteKey: session.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: session.id,
      eventType,
      sent: false,
      reason: `handler error: ${safeErr(err)}`,
    });
    return new Response("Internal Server Error", { status: 500 });
  }
}
