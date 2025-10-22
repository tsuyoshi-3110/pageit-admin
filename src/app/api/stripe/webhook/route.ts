// app/api/stripe/webhook/route.ts
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { stripeConnect } from "@/lib/stripe-connect";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail } from "@/lib/mailer";
import { normalizeLang } from "./i18n"
import { type LangKey} from "./type";
import { buyerText } from "./i18n";

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
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
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
  ja: "ja-JP",
  en: "en",
  fr: "fr-FR",
  es: "es-ES",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  "pt-BR": "pt-BR",
  ko: "ko-KR",
  zh: "zh-CN",
  "zh-TW": "zh-TW",
  ru: "ru-RU",
  th: "th-TH",
  vi: "vi-VN",
  id: "id-ID",
};

async function findSiteKeyByCustomerId(
  customerId: string
): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSettings")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}
async function findSiteKeyByConnectAccount(
  connectAccountId: string
): Promise<string | null> {
  const snap = await adminDb
    .collection("siteSellers")
    .where("stripe.connectAccountId", "==", connectAccountId)
    .limit(1)
    .get();
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
  await adminDb
    .collection("orderMails")
    .add({ ...rec, createdAt: FieldValue.serverTimestamp() });
}



/* ----------------------------- i18n ----------------------------- */


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
  console.log(
    "[webhook] listLineItems scope:",
    scope,
    "count:",
    li.data.length
  );

  const langs: LangKey[] = [
    "ja",
    "en",
    "fr",
    "es",
    "de",
    "it",
    "pt",
    "pt-BR",
    "ko",
    "zh",
    "zh-TW",
    "ru",
    "th",
    "vi",
    "id",
  ];
  const base = preferLang.split("-")[0] as LangKey;

  return li.data.map((x) => {
    const prod =
      typeof x.price?.product === "string"
        ? undefined
        : (x.price?.product as Stripe.Product);
    const md = (prod?.metadata ?? {}) as Record<string, string>;
    const desc = (x.description || "").trim();

    const metaPrefer =
      md[`name_${preferLang}`] || md[`name_${base}`] || md.name;

    const defaultName = desc || metaPrefer || prod?.name || "Item";

    const names: MailItem["names"] = { default: defaultName };
    for (const lk of langs) {
      // ここを強化：ja のときは name_ja が無ければ name を使う
      const v = md[`name_${lk}`] || (lk === "ja" ? md["name"] : undefined);
      if (typeof v === "string" && v.trim()) names[lk] = v.trim();
    }
    // 既存のフォールバックはそのまま
    if (!names.ja) names.ja = defaultName;
    if (!names.en) names.en = defaultName;

    const qty = x.quantity ?? 1;
    const subMajor = toMajor(
      x.amount_subtotal ?? x.amount_total ?? 0,
      session.currency
    );
    const unitMajor = subMajor / Math.max(1, qty);

    return { names, qty, unitAmount: unitMajor, subtotal: subMajor };
  });
}

/** 🔸日本語固定（オーナー/バイヤー=ja用）：Firestore の base.title を必ず使う */
async function buildJaItemsFromFirestore(
  session: Stripe.Checkout.Session,
  reqOpts?: Stripe.RequestOptions
): Promise<MailItem[]> {
  const li = await stripeConnect.checkout.sessions.listLineItems(
    session.id,
    { limit: 100, expand: ["data.price.product"] },
    reqOpts
  );

  const out: MailItem[] = [];
  for (const x of li.data) {
    const prod =
      typeof x.price?.product === "string"
        ? undefined
        : (x.price?.product as Stripe.Product);
    const md = (prod?.metadata ?? {}) as Record<string, string>;
    const pid = md.productId;
    const sk = md.siteKey || (session.metadata?.siteKey ?? null);

    let jaName = "";
    // 1) Firestore の base.title を最優先
    if (pid && sk) {
      try {
        const doc = await adminDb.doc(`siteProducts/${sk}/items/${pid}`).get();
        const d = doc.data() as any;
        jaName =
          (typeof d?.base?.title === "string" && d.base.title.trim()) ||
          (typeof d?.title === "string" && d.title.trim()) ||
          "";
      } catch {}
    }
    // 2) 取れなければ Stripe 側情報にフォールバック
    if (!jaName) {
      const desc = (x.description || "").trim();
      jaName = desc || (prod?.name ?? "") || "商品";
    }

    const qty = x.quantity ?? 1;
    const subMajor = toMajor(
      x.amount_subtotal ?? x.amount_total ?? 0,
      session.currency
    );
    const unitMajor = subMajor / Math.max(1, qty);

    out.push({
      names: { default: jaName, ja: jaName }, // 日本語固定
      qty,
      unitAmount: unitMajor,
      subtotal: subMajor,
    });
  }
  return out;
}

/* ----------------------------- HTML ----------------------------- */
// （buildOwnerHtmlJa / buildBuyerHtmlI18n は元のまま）
function buildOwnerHtmlJa(
  session: Stripe.Checkout.Session & { shipping_details?: ShippingDetails },
  items: MailItem[]
) {
  /* …（元の関数本文そのまま）… */
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = "ja-JP";
  const ship = (session as any).shipping_details as any;
  const cust = session.customer_details;
  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined =
    ship?.address ?? cust?.address ?? undefined;
  const addr = [
    addrObj?.postal_code ? `〒${addrObj.postal_code}` : "",
    addrObj?.state,
    addrObj?.city,
    addrObj?.line1,
    addrObj?.line2,
    addrObj?.country && addrObj?.country !== "JP" ? addrObj.country : "",
  ]
    .filter(Boolean)
    .join(" ");
  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);
  const rows = items
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(
          it,
          "ja"
        )}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(
          it.unitAmount,
          cur,
          locale
        )}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${
          it.qty
        }</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(
          it.subtotal,
          cur,
          locale
        )}</td>
      </tr>`
    )
    .join("");
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
    <h2>新しい注文が完了しました</h2>
    <p>注文ID: <b>${session.id}</b>／支払い: <b>${
    session.payment_status
  }</b></p>
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
  /* …（元の関数本文そのまま）… */
  const t = buyerText[lang] || buyerText.en;
  const cur = (session.currency || "jpy").toUpperCase();
  const locale = LOCALE_BY_LANG[lang] || "en";
  const ship = (session as any).shipping_details as any;
  const cust = session.customer_details;
  const name = ship?.name ?? cust?.name ?? "-";
  const phone = cust?.phone ?? ship?.phone ?? "-";
  const addrObj: Stripe.Address | undefined =
    ship?.address ?? cust?.address ?? undefined;
  const addr = [
    addrObj?.postal_code,
    addrObj?.state,
    addrObj?.city,
    addrObj?.line1,
    addrObj?.line2,
    addrObj?.country && addrObj?.country !== "JP" ? addrObj.country : "",
  ]
    .filter(Boolean)
    .join(" ");
  const buyer = cust?.email || session.customer_email || "-";
  const total = toMajor(session.amount_total, session.currency);
  const rows = items
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${getName(
          it,
          lang
        )}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(
          it.unitAmount,
          cur,
          locale
        )}</td>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;">${
          it.qty
        }</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;">${fmtCur(
          it.subtotal,
          cur,
          locale
        )}</td>
      </tr>`
    )
    .join("");
  return {
    subject: t.subject,
    html: `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;">
      <h2>${t.heading}</h2>
      <p>${t.orderId}: <b>${session.id}</b> / ${t.payment}: <b>${
      session.payment_status
    }</b></p>
      <p>${t.buyer}: <b>${buyer}</b></p>
      <table style="border-collapse:collapse;width:100%;max-width:680px;">
        <thead><tr>
          <th style="text-align:left;border-bottom:2px solid #333;">${
            t.table.name
          }</th>
          <th style="text-align:right;border-bottom:2px solid #333;">${
            t.table.unit
          }</th>
          <th style="text-align:center;border-bottom:2px solid #333;">${
            t.table.qty
          }</th>
          <th style="text-align:right;border-bottom:2px solid #333;">${
            t.table.subtotal
          }</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:12px;"><b>${t.total}: ${fmtCur(
      total,
      cur,
      locale
    )}</b></p>
      <h3>${t.shipTo}</h3>
      <p>${t.name}: ${name}<br/>${t.phone}: ${phone}<br/>${t.address}: ${
      addr || "-"
    }</p>
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
    await logOrderMail({
      siteKey: null,
      ownerEmail: null,
      sessionId: null,
      eventType: "missing_signature",
      sent: false,
      reason: "stripe-signature header missing",
    });
    return new Response("OK", { status: 200 });
  }

  let event: Stripe.Event;
  try {
    event = stripeConnect.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", safeErr(err));
    await logOrderMail({
      siteKey: null,
      ownerEmail: null,
      sessionId: null,
      eventType: "signature_error",
      sent: false,
      reason: `signature error: ${safeErr(err)}`,
    });
    return new Response("OK", { status: 200 });
  }

  // ---- 冪等ガード（再送でも二重処理しない）----
  const eventRef = adminDb.collection("stripeEvents").doc(event.id);
  const eventSnap = await eventRef.get();
  if (eventSnap.exists) {
    return new Response("OK", { status: 200 });
  }

  if (event.type !== "checkout.session.completed") {
    // 他イベントは今はスルー、ただし冪等マークだけ残すならここで set してもOK
    await eventRef.set({
      type: event.type,
      created: new Date(),
      skipped: true,
    });
    return new Response("OK", { status: 200 });
  }

  const connectedAccountId = (event as any).account as string | undefined;
  const reqOpts: Stripe.RequestOptions | undefined = connectedAccountId
    ? { stripeAccount: connectedAccountId }
    : undefined;

  const session = event.data.object as Stripe.Checkout.Session & {
    metadata?: {
      siteKey?: string;
      lang?: string;
      uiLang?: string;
      transferGroup?: string;
      sellerConnectId?: string;
      platformFeePct?: string;
    };
    shipping_details?: ShippingDetails;
  };

  try {
    /* 0) pendingOrders を取得（在庫減算の正） */
    const pendingRef = adminDb.collection("pendingOrders").doc(session.id);
    const pendingSnap = await pendingRef.get();

    let siteKeyFromPending: string | null = null;
    let pendingItems: Array<{ id: string; name?: string; quantity: number }> =
      [];

    if (pendingSnap.exists) {
      const p = pendingSnap.data() as any;
      siteKeyFromPending = p.siteKey || null;
      pendingItems = Array.isArray(p.items)
        ? p.items.map((x: any) => ({
            id: String(x.id),
            name: x.name,
            quantity: Number(x.quantity || 0),
          }))
        : [];
    }

    /* A) PaymentIntent / 決済手段 & 電話番号 */
    let pi: Stripe.PaymentIntent | null = null;
    try {
      try {
        pi = await stripeConnect.paymentIntents.retrieve(
          session.payment_intent as string,
          { expand: ["latest_charge"] }
        );
      } catch {
        pi = await stripeConnect.paymentIntents.retrieve(
          session.payment_intent as string,
          { expand: ["latest_charge"] },
          reqOpts
        );
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
      session.metadata?.lang ||
        session.metadata?.uiLang ||
        (session.locale as any) ||
        "en"
    );

    let items: MailItem[] = [];
    try {
      items = await buildItemsFromStripe(session, reqOpts, buyerLang);
    } catch (e) {
      console.error("❌ listLineItems failed:", safeErr(e));
      const totalMajor = toMajor(session.amount_total, session.currency);
      items = [
        {
          names: { default: "Item" },
          qty: 1,
          unitAmount: totalMajor,
          subtotal: totalMajor,
        },
      ];
    }

    /* C) siteKey 解決（pending優先 → metadata → account → customer） */
    const customerId = (session.customer as string) || null;
    const siteKey: string | null =
      siteKeyFromPending ??
      session.metadata?.siteKey ??
      (connectedAccountId
        ? await findSiteKeyByConnectAccount(connectedAccountId)
        : null) ??
      session.client_reference_id ??
      (customerId ? await findSiteKeyByCustomerId(customerId) : null);

    /* D) 🔸 在庫減算（トランザクション + 冪等マーク） */
    const li = await stripeConnect.checkout.sessions.listLineItems(
      session.id,
      { limit: 100, expand: ["data.price.product"] },
      reqOpts
    );
    await adminDb.runTransaction(async (tx) => {
      // 既に処理済みならスキップ（pending.status === 'paid'）
      const pSnapTx = await tx.get(pendingRef);
      const paidAlready = pSnapTx.exists && pSnapTx.get("status") === "paid";
      if (paidAlready) {
        tx.set(eventRef, {
          type: event.type,
          created: new Date(),
          sessionId: session.id,
          idempotent: true,
        });
        return;
      }

      // 減算対象の決定（pending 優先 → Stripe line items フォールバック）
      let decList: Array<{ id: string; qty: number }> = [];
      if (pendingItems.length > 0) {
        decList = pendingItems.map((x) => ({
          id: x.id,
          qty: Math.max(0, Number(x.quantity || 0)),
        }));
      } else if (siteKey) {
        decList = li.data
          .map((x) => {
            const prod =
              typeof x.price?.product === "string"
                ? undefined
                : (x.price?.product as Stripe.Product);
            const pid = (prod?.metadata as any)?.productId as
              | string
              | undefined;
            const qty = x.quantity ?? 0;
            return pid ? { id: pid, qty: Math.max(0, qty) } : null;
          })
          .filter(Boolean) as any[];
      }

      // ---- ここから「stock」コレクションを更新 ----
      if (siteKey && decList.length > 0) {
        for (const row of decList) {
          const stockId = `${siteKey}__p:${row.id}`;
          const stockRef = adminDb.collection("stock").doc(stockId);
          const s = await tx.get(stockRef);

          if (!s.exists) {
            // 在庫ドキュメントが無ければ作成（0個）。この注文では減算は実質 0 と同じ。
            tx.set(stockRef, {
              id: stockId,
              siteKey,
              productId: row.id,
              sku: null,
              name: null,
              stockQty: 0,
              lowStockThreshold: 0,
              updatedAt: new Date(),
            });
            continue;
          }

          const before = Number(s.get("stockQty") ?? 0);
          const after = Math.max(0, before - row.qty); // マイナスにならないよう下限0
          tx.update(stockRef, { stockQty: after, updatedAt: new Date() });

          // 任意：調整ログ
          const logRef = adminDb.collection("stockAdjustments").doc();
          tx.set(logRef, {
            siteKey,
            stockId,
            sku: s.get("sku") ?? null,
            delta: after - before, // 負数
            type: "decrement",
            reason: "sale",
            beforeQty: before,
            afterQty: after,
            createdAt: new Date(),
          });
        }
      }

      // pending の状態更新（存在すれば）
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
      tx.set(eventRef, {
        type: event.type,
        created: new Date(),
        sessionId: session.id,
      });
    });

    /* E) siteOrders 保存（表示名は buyerLang 優先） */
    // 🔸バイヤーが日本語なら base.title で組み直した items を使う
    const itemsForBuyer =
      buyerLang === "ja"
        ? await buildJaItemsFromFirestore(session, reqOpts)
        : items;

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
        name:
          session.customer_details?.name ??
          (session as any).shipping_details?.name ??
          null,
        phone: phoneFallback,
        address:
          session.customer_details?.address ??
          (session as any).shipping_details?.address ??
          null,
      },
      items: itemsForBuyer.map((i) => ({
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
      await adminDb
        .doc(`siteSettings/${siteKey}`)
        .set({ stripeCustomerId: customerIdResolved }, { merge: true });
    }

    // async function getHoldDays(): Promise<number> {
    //   try {
    //     // UI と同じ保存先を優先
    //     const g = await adminDb.doc("adminSettings/global").get();
    //     const v = Number(g.get("payoutHoldDays"));
    //     if (Number.isFinite(v) && v >= 0) return v;
    //   } catch {}
    //   try {
    //     // 旧設定のフォールバック（残しておくと安全）
    //     const p = await adminDb.doc("platformConfig/payouts").get();
    //     const n = Number(p.get("holdDays"));
    //     if (Number.isFinite(n) && n >= 0) return n;
    //   } catch {}
    //   return 30; // 最終フォールバック
    // }

    async function resolveHoldMs(siteKey: string | null): Promise<number> {
      // 1) サイト個別上書き（分・秒）
      try {
        if (siteKey) {
          const s = await adminDb.doc(`siteSellers/${siteKey}`).get();
          const min = Number(s.get("testHoldMinutes"));
          if (Number.isFinite(min) && min >= 0) return min * 60 * 1000;
          const sec = Number(s.get("testHoldSeconds"));
          if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
        }
      } catch {}

      // 2) 全体上書き（adminSettings/global）
      try {
        const g = await adminDb.doc("adminSettings/global").get();
        const min = Number(g.get("payoutHoldMinutes"));
        if (Number.isFinite(min) && min >= 0) return min * 60 * 1000;
        const sec = Number(g.get("payoutHoldSeconds"));
        if (Number.isFinite(sec) && sec >= 0) return sec * 1000;

        const days = Number(g.get("payoutHoldDays"));
        if (Number.isFinite(days) && days >= 0)
          return days * 24 * 60 * 60 * 1000;
      } catch {}

      // 3) 旧レガシー場所（互換）
      try {
        const p = await adminDb.doc("platformConfig/payouts").get();
        const days = Number(p.get("holdDays"));
        if (Number.isFinite(days) && days >= 0)
          return days * 24 * 60 * 60 * 1000;
      } catch {}

      // 4) 環境変数
      const envMin = Number(PAYOUT_HOLD_MINUTES);
      if (Number.isFinite(envMin) && envMin >= 0) return envMin * 60 * 1000;

      // 5) デフォルト 30日
      return 30 * 24 * 60 * 60 * 1000;
    }

    /* G) 🔸 エスクロー記録（SCT: 後日 transfer 解放用） */
    const DEFAULT_PLATFORM_FEE_RATE = 0.07;
    // const holdDays = await getHoldDays();
    const holdMs = await resolveHoldMs(siteKey || null);
    const now = new Date();
    const releaseAt = new Date(now.getTime() + holdMs);

    const transferGroup = session.metadata?.transferGroup || null;
    const sellerConnectIdEscrow =
      session.metadata?.sellerConnectId || connectedAccountId || null;

    const gross = session.amount_total ?? 0; // 最小通貨単位
    const pctMeta = session.metadata?.platformFeePct;
    const feeRate = Number.isFinite(Number(pctMeta))
      ? Number(pctMeta)
      : DEFAULT_PLATFORM_FEE_RATE;
    const platformFee = Math.floor(gross * feeRate);
    const sellerAmount = Math.max(0, gross - platformFee);

    const currency = (session.currency || "jpy").toLowerCase();
    // const now = new Date();
    // const releaseAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000);

    const chargeId =
      (pi?.latest_charge as Stripe.Charge | undefined)?.id || null;

    await adminDb
      .collection("escrows")
      .doc(session.id)
      .set({
        siteKey: siteKey || null,
        sessionId: session.id,
        currency,
        gross,
        platformFee,
        sellerAmount,
        sellerConnectId: sellerConnectIdEscrow,
        transferGroup,
        status: "held", // ← 'held' に統一（API側のクエリと合わせる）
        paymentIntentId: pi?.id || null,
        chargeId, // ← pending資金でも送れるよう保存（超重要）
        manualHold: false, // ← 明示
        createdAt: now,
        releaseAt,
      });

    /* H) オーナー宛（日本語固定） */
    if (siteKey) {
      const ownerEmail = await getOwnerEmail(siteKey);
      if (ownerEmail) {
        // 🔸オーナー通知は常に base.title（日本語）
        const itemsForOwner = await buildJaItemsFromFirestore(session, reqOpts);
        const ownerHtml = buildOwnerHtmlJa(session, itemsForOwner);
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
            eventType: event.type,
            sent: true,
          });
        } catch (e) {
          console.error("❌ sendMail(owner) failed:", safeErr(e));
          await logOrderMail({
            siteKey,
            ownerEmail,
            sessionId: session.id,
            eventType: event.type,
            sent: false,
            reason: `sendMail(owner) failed: ${safeErr(e)}`,
          });
        }
      } else {
        await logOrderMail({
          siteKey,
          ownerEmail: null,
          sessionId: session.id,
          eventType: event.type,
          sent: false,
          reason: `ownerEmail not found at siteSettings/${siteKey}`,
        });
      }
    } else {
      await logOrderMail({
        siteKey: null,
        ownerEmail: null,
        sessionId: session.id,
        eventType: event.type,
        sent: false,
        reason: "siteKey unresolved",
        extras: {
          connectedAccountId,
          customerId: session.customer,
          metadata: session.metadata ?? null,
        },
      });
    }

    /* I) 購入者宛（多言語レシート） */
    try {
      const buyerEmail =
        session.customer_details?.email || session.customer_email || null;
      if (buyerEmail) {
        // 🔸バイヤーが日本語なら base.title で構築した items を使う
        const buyerItemsForMail = itemsForBuyer;
        const buyerMail = buildBuyerHtmlI18n(buyerLang, session, buyerItemsForMail);
        await sendMail({
          to: buyerEmail,
          subject: buyerMail.subject,
          html: buyerMail.html,
        });
      }
    } catch (e) {
      console.error("❌ sendMail(buyer) failed:", safeErr(e));
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("🔥 webhook handler error:", safeErr(err));
    await eventRef.set(
      {
        type: event.type,
        created: new Date(),
        errored: true,
        reason: safeErr(err),
      },
      { merge: true }
    );
    await logOrderMail({
      siteKey: (event.data.object as any)?.metadata?.siteKey ?? null,
      ownerEmail: null,
      sessionId: (event.data.object as any)?.id ?? null,
      eventType: event.type,
      sent: false,
      reason: `handler error: ${safeErr(err)}`,
    });
    // Stripe の過剰リトライを避けるため 200 を返す方針
    return new Response("OK", { status: 200 });
  }
}
