// lib/createInvoicePdf.ts
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export type InvoiceParams = {
  customerName: string;
  setupSelected: boolean;
  shootingSelected: boolean;
  setupPrice?: number;
  shootingPrice?: number;
  satueiSelected: boolean;
  henshuSelected: boolean;
  satueiPrice?: number;
  henshuPrice?: number;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  logoPath: string; // ← URL形式で渡す
  itemIconPath?: string; // ← URL形式で渡す
};

export async function createInvoicePdf(p: InvoiceParams): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // ✅ フォントをURL経由で取得（Noto Sans JP）
  const fontRes = await fetch(
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf"
  );
  const fontBuffer = await fontRes.arrayBuffer();
  const jpFont = await pdfDoc.embedFont(fontBuffer);

  const page = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();
  const LEFT = 55;
  const GAP = 20;
  const HEADER_H = 90;

  // ✅ ロゴ画像の読み込み（fetch → ArrayBuffer → embed）
  const logoRes = await fetch(p.logoPath);
  const logoBuffer = await logoRes.arrayBuffer();
  const logoImg = p.logoPath.toLowerCase().endsWith(".png")
    ? await pdfDoc.embedPng(logoBuffer)
    : await pdfDoc.embedJpg(logoBuffer);

  const logoDim = logoImg.scale(60 / logoImg.height);
  // ロゴの描画位置を変数にして再利用
  const logoX = width - logoDim.width - 40;
  const logoY = height - HEADER_H + (HEADER_H - logoDim.height) / 2;

  page.drawImage(logoImg, {
    x: width - logoDim.width - 40,
    y: height - HEADER_H + (HEADER_H - logoDim.height) / 2,
    ...logoDim,
  });

  // ★ 追加：ロゴの真下にブランド名をセンタリングして描画
  const BRAND_LABEL = "Xenovant";
  const brandSize = 14; // お好みで
  const brandGap = 6;
  const brandWidth = jpFont.widthOfTextAtSize(BRAND_LABEL, brandSize);

  page.drawText(BRAND_LABEL, {
    x: logoX + (logoDim.width - brandWidth) / 2, // ロゴの中央に合わせる
    y: logoY - brandGap, // ロゴの少し下に配置（行間はお好みで）
    size: brandSize,
    font: jpFont,
    color: rgb(0.15, 0.15, 0.15),
  });

  page.drawText("請  求  書", {
    x: LEFT,
    y: height - 50,
    size: 30,
    font: jpFont,
    color: rgb(0, 0, 0),
  });

  page.drawText("登録番号-T4120001209252", {
    x: LEFT,
    y: height - 70,
    size: 12,
    font: jpFont,
    color: rgb(0, 0, 0),
  });

  let yPos = height - HEADER_H - 45;
  const drawRow = (label: string, val: string) => {
    page.drawText(label, { x: LEFT, y: yPos, size: 12, font: jpFont });
    page.drawText(val, { x: LEFT + 110, y: yPos, size: 12, font: jpFont });
    yPos -= GAP;
  };

  drawRow("請求日", p.invoiceDate);
  drawRow("支払期限", p.dueDate);
  drawRow("宛　先", `${p.customerName} 様`);

  yPos -= 12;
  const TABLE_W = 480;
  const LABEL_W = 250;
  const PRICE_R = LEFT + TABLE_W;
  const HEAD_H = 22;

  page.drawRectangle({
    x: LEFT,
    y: yPos,
    width: TABLE_W,
    height: HEAD_H,
    color: rgb(0.85, 0.85, 0.85),
  });

  // ✅ アイコンを読み込み（任意）
  if (p.itemIconPath) {
    const iconRes = await fetch(p.itemIconPath);
    const iconBuffer = await iconRes.arrayBuffer();
    const iconImg = p.itemIconPath.toLowerCase().endsWith(".png")
      ? await pdfDoc.embedPng(iconBuffer)
      : await pdfDoc.embedJpg(iconBuffer);

    const iconHeight = 60;
    const iconYOffset = -50;
    const iconDim = iconImg.scale(iconHeight / iconImg.height);

    const iconX = LEFT + 8;
    const iconY = yPos - 40 + iconYOffset;

    page.drawImage(iconImg, {
      x: iconX,
      y: iconY,
      ...iconDim,
    });
  }

  page.drawText("項目", {
    x: LEFT + LABEL_W / 2 - jpFont.widthOfTextAtSize("項目", 11) / 2,
    y: yPos + 6,
    size: 11,
    font: jpFont,
  });

  const hdr = "金額(円)";
  page.drawText(hdr, {
    x: PRICE_R - 8 - jpFont.widthOfTextAtSize(hdr, 11),
    y: yPos + 6,
    size: 11,
    font: jpFont,
  });

  yPos -= HEAD_H;

  const items: [string, number][] = [];
  if (p.setupSelected) items.push(["初期セットアップ", p.setupPrice ?? 30000]);
  if (p.shootingSelected)
    items.push(["撮影編集代行", p.shootingPrice ?? 50000]);
  if (p.satueiSelected) items.push(["撮影代行", p.satueiPrice ?? 35000]);
  if (p.henshuSelected) items.push(["編集代行", p.henshuPrice ?? 15000]);

  const amount = items.reduce((sum, [, price]) => sum + price, 0);
  const tax = Math.round(amount * 0.1);
  const total = amount + tax;

  items.push(["消費税 (10%)", tax], ["合計（税込）", total]);

  items.forEach(([label, price]) => {
    yPos -= GAP;

    const lblW = jpFont.widthOfTextAtSize(label, 12);
    page.drawText(label, {
      x: LEFT + LABEL_W / 2 - lblW / 2,
      y: yPos,
      size: 12,
      font: jpFont,
    });

    const priceTxt = price.toLocaleString();
    const priceW = jpFont.widthOfTextAtSize(priceTxt, 12);
    page.drawText(priceTxt, {
      x: PRICE_R - 10 - priceW,
      y: yPos,
      size: 12,
      font: jpFont,
    });
  });

  const BANK_INFO_Y_START = 100; // 以前: 200（小さくすると下に移動）
  const BANK_INFO_LABEL_X = LEFT + 300; // 以前: LEFT + 300（増やすと右へ）
  const BANK_INFO_TEXT_X = LEFT + 325; // 以前: LEFT + 325（増やすと右へ）

  const BANK_INFO_LINES = [
    "三菱ＵＦＪ銀行　新大阪支店",
    "普通　5002177",
    "サイトウ　ツヨシ",
  ];

  page.drawText("【振込先】", {
    x: BANK_INFO_LABEL_X,
    y: BANK_INFO_Y_START,
    size: 12,
    font: jpFont,
  });

  BANK_INFO_LINES.forEach((txt, i) => {
    page.drawText(txt, {
      x: BANK_INFO_TEXT_X,
      y: BANK_INFO_Y_START - GAP * (i + 1),
      size: 12,
      font: jpFont,
    });
  });

  return pdfDoc.save();
}
