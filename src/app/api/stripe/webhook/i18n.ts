import { type LangKey} from "./type";

export function normalizeLang(input?: string | null): LangKey {
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


export const buyerText: Record<

  LangKey,
  {
    subject: string;
    heading: string;
    orderId: string;
    payment: string;
    buyer: string;
    table: { name: string; unit: string; qty: string; subtotal: string };
    total: string;
    shipTo: string;
    name: string;
    phone: string;
    address: string;
    footer: string;
  }
> = {
  ja: {
    subject: "ご購入ありがとうございます（レシート）",
    heading: "ご注文ありがとうございます",
    orderId: "注文ID",
    payment: "支払い",
    buyer: "購入者",
    table: { name: "商品名", unit: "単価", qty: "数量", subtotal: "小計" },
    total: "合計",
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
    table: {
      name: "Item",
      unit: "Unit price",
      qty: "Qty",
      subtotal: "Subtotal",
    },
    total: "Total",
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
    table: {
      name: "Article",
      unit: "Prix unitaire",
      qty: "Qté",
      subtotal: "Sous-total",
    },
    total: "Total",
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
    table: {
      name: "Producto",
      unit: "Precio unitario",
      qty: "Cant.",
      subtotal: "Subtotal",
    },
    total: "Total",
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
    table: {
      name: "Artikel",
      unit: "Einzelpreis",
      qty: "Menge",
      subtotal: "Zwischensumme",
    },
    total: "Gesamt",
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
    table: {
      name: "Articolo",
      unit: "Prezzo unitario",
      qty: "Qtà",
      subtotal: "Subtotale",
    },
    total: "Totale",
    shipTo: "Indirizzo di spedizione",
    name: "Nome",
    phone: "Telefono",
    address: "Indirizzo",
    footer:
      "Questa e-mail è stata inviata automaticamente dal webhook di Stripe.",
  },
  pt: {
    subject: "Obrigado pela compra (recibo)",
    heading: "Obrigado pelo seu pedido",
    orderId: "ID do pedido",
    payment: "Pagamento",
    buyer: "Comprador",
    table: {
      name: "Item",
      unit: "Preço unitário",
      qty: "Qtd",
      subtotal: "Subtotal",
    },
    total: "Total",
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
    table: {
      name: "Item",
      unit: "Preço unitário",
      qty: "Qtd",
      subtotal: "Subtotal",
    },
    total: "Total",
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
    table: { name: "상품명", unit: "단가", qty: "수량", subtotal: "소계" },
    total: "합계",
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
    table: { name: "商品名称", unit: "单价", qty: "数量", subtotal: "小计" },
    total: "合计",
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
    table: { name: "商品名稱", unit: "單價", qty: "數量", subtotal: "小計" },
    total: "合計",
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
    table: {
      name: "Товар",
      unit: "Цена",
      qty: "Кол-во",
      subtotal: "Промежуточный итог",
    },
    total: "Итого",
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
    table: {
      name: "สินค้า",
      unit: "ราคาต่อหน่วย",
      qty: "จำนวน",
      subtotal: "ยอดย่อย",
    },
    total: "ยอดรวม",
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
    table: {
      name: "Sản phẩm",
      unit: "Đơn giá",
      qty: "SL",
      subtotal: "Tạm tính",
    },
    total: "Tổng",
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
    table: {
      name: "Produk",
      unit: "Harga satuan",
      qty: "Jml",
      subtotal: "Subtotal",
    },
    total: "Total",
    shipTo: "Alamat pengiriman",
    name: "Nama",
    phone: "Telepon",
    address: "Alamat",
    footer: "Email ini dikirim otomatis oleh Stripe Webhook.",
  },
};
