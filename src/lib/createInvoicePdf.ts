// lib/createInvoicePdf.ts
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export type InvoiceItem = { label: string; unitPrice: number; qty: number };

export type InvoiceParams = {
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  logoPath: string; // URL
  itemIconPath?: string; // URL (任意)
  items: InvoiceItem[];
};

export async function createInvoicePdf(p: InvoiceParams): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // 日本語フォント
  const fontRes = await fetch(
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf"
  );
  const fontBuffer = await fontRes.arrayBuffer();
  const jpFont = await pdfDoc.embedFont(fontBuffer);

  const page = pdfDoc.addPage([595, 842]); // A4縦
  const { width, height } = page.getSize();

  const LEFT = 55;
  const GAP = 20;
  const HEADER_H = 90;

  // 右上ブランドロゴ
  const logoRes = await fetch(p.logoPath);
  const logoBuffer = await logoRes.arrayBuffer();
  const logoImg = p.logoPath.toLowerCase().endsWith(".png")
    ? await pdfDoc.embedPng(logoBuffer)
    : await pdfDoc.embedJpg(logoBuffer);
  const logoDim = logoImg.scale(60 / logoImg.height);
  const logoX = width - logoDim.width - 40;
  const logoY = height - HEADER_H + (HEADER_H - logoDim.height) / 2;
  page.drawImage(logoImg, { x: logoX, y: logoY, ...logoDim });

  // ブランド名
  const BRAND_LABEL = "Xenovant";
  const brandSize = 14;
  const brandWidth = jpFont.widthOfTextAtSize(BRAND_LABEL, brandSize);
  page.drawText(BRAND_LABEL, {
    x: logoX + (logoDim.width - brandWidth) / 2,
    y: logoY - 6,
    size: brandSize,
    font: jpFont,
    color: rgb(0.15, 0.15, 0.15),
  });

  // 見出し
  page.drawText("請  求  書", {
    x: LEFT,
    y: height - 50,
    size: 30,
    font: jpFont,
  });
  page.drawText(`登録番号-${p.invoiceNumber}`, {
    x: LEFT,
    y: height - 70,
    size: 12,
    font: jpFont,
  });

  // 請求情報
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

  // テーブル定義
  const TABLE_W = 480;
  const COL_LABEL_W = 230; // 項目
  const COL_UNIT_W = 90; // 単価(円)
  const COL_QTY_W = 60; // 数量
  const COL_SUB_W = 100; // 小計(円)
  const HEAD_H = 22;
  const ROW_H = 24;

  const TABLE_X = LEFT;

  // 列の基準座標
  const unitColCenter = TABLE_X + COL_LABEL_W + COL_UNIT_W / 2; // 単価：中央寄せ
  const qtyColCenter = TABLE_X + COL_LABEL_W + COL_UNIT_W + COL_QTY_W / 2; // 数量：中央寄せ
  const subColRight =
    TABLE_X + COL_LABEL_W + COL_UNIT_W + COL_QTY_W + COL_SUB_W; // 小計：右寄せ

  // ヘッダー帯
  const headerBottomY = yPos; // 帯の下端
  page.drawRectangle({
    x: TABLE_X,
    y: headerBottomY,
    width: TABLE_W,
    height: HEAD_H,
    color: rgb(0.85, 0.85, 0.85),
  });

  // ★ アイテムアイコン（大きく＆右上）：ヘッダーの上、右寄りに配置
  // ★ アイテムアイコン（ヘッダーの上・右寄り）
  if (p.itemIconPath) {
    const iconRes = await fetch(p.itemIconPath);
    const iconBuffer = await iconRes.arrayBuffer();
    const iconImg = p.itemIconPath.toLowerCase().endsWith(".png")
      ? await pdfDoc.embedPng(iconBuffer)
      : await pdfDoc.embedJpg(iconBuffer);

    // ↓ここを好みの大きさに（例: 40, 48, 56 など）
    const ICON_H = 48; // ← “もっと大きく”のサイズ
    const MARGIN_RIGHT = 6; // 右側の余白
    const MARGIN_ABOVE = 2; // ヘッダー上からの距離

    const iconDim = iconImg.scale(ICON_H / iconImg.height);

    // ページ端に被らないようにクランプ
    const rightMargin = width - 40; // 右マージン
    const topMargin = height - 40; // 上マージン

    // 小計列の右端を基準に右寄せ
    let iconX = subColRight - MARGIN_RIGHT - iconDim.width;
    iconX = Math.min(iconX, rightMargin - iconDim.width); // 右端はみ出し防止

    // ヘッダーの少し上に配置
    let iconY = headerBottomY + HEAD_H + MARGIN_ABOVE;
    iconY = Math.min(iconY, topMargin - iconDim.height); // 上端はみ出し防止

    page.drawImage(iconImg, { x: iconX, y: iconY, ...iconDim });
  }

  // ヘッダー文字
  const headY = headerBottomY + 6;
  const put = (text: string, x: number) =>
    page.drawText(text, { x, y: headY, size: 11, font: jpFont });
  put("項目", TABLE_X + 8);
  put("単価(円)", unitColCenter - jpFont.widthOfTextAtSize("単価(円)", 11) / 2);
  put("数量", qtyColCenter - jpFont.widthOfTextAtSize("数量", 11) / 2);
  put("小計(円)", subColRight - 8 - jpFont.widthOfTextAtSize("小計(円)", 11));

  // 明細スタート
  yPos -= HEAD_H;

  // 明細行
  const items = p.items.filter((it) => it.qty > 0 && it.unitPrice >= 0);
  let subTotal = 0;

  for (const it of items) {
    const lineTotal = it.unitPrice * it.qty;
    subTotal += lineTotal;
    yPos -= ROW_H;

    // 項目（左寄せ）
    page.drawText(it.label, {
      x: TABLE_X + 8,
      y: yPos + 6,
      size: 12,
      font: jpFont,
    });

    // 単価（列センターで中央寄せ）
    const unitTxt = it.unitPrice.toLocaleString();
    const unitW = jpFont.widthOfTextAtSize(unitTxt, 12);
    page.drawText(unitTxt, {
      x: unitColCenter - unitW / 2,
      y: yPos + 6,
      size: 12,
      font: jpFont,
    });

    // 数量（中央寄せ）
    const qtyTxt = String(it.qty);
    const qtyW = jpFont.widthOfTextAtSize(qtyTxt, 12);
    page.drawText(qtyTxt, {
      x: qtyColCenter - qtyW / 2,
      y: yPos + 6,
      size: 12,
      font: jpFont,
    });

    // 小計（右寄せ）
    const subTxt = lineTotal.toLocaleString();
    const subW = jpFont.widthOfTextAtSize(subTxt, 12);
    page.drawText(subTxt, {
      x: subColRight - 10 - subW,
      y: yPos + 6,
      size: 12,
      font: jpFont,
    });
  }

  // ★ 区切り線（赤線位置）：明細の直下に黒い水平線を引く
  if (items.length > 0) {
    const DIVIDER_Y = yPos - 6; // 最終行の少し下
    page.drawRectangle({
      x: TABLE_X,
      y: DIVIDER_Y,
      width: TABLE_W,
      height: 1,
      color: rgb(0.8, 0.8, 0.8), // ← 黒(0,0,0) → 薄いグレー
    });
  }

  // 合計欄（ラベルは項目列に揃える、数値は小計列右端に揃える）
  const tax = Math.round(subTotal * 0.1);
  const grand = subTotal + tax;

  const labelX = TABLE_X + 8; // ラベルを“項目”列左端へ
  const valRight = subColRight - 10; // 金額は小計列の右端

  const drawRightRow = (label: string, val: number) => {
    yPos -= ROW_H;
    page.drawText(label, { x: labelX, y: yPos + 6, size: 12, font: jpFont });
    const vTxt = val.toLocaleString();
    const vW = jpFont.widthOfTextAtSize(vTxt, 12);
    page.drawText(vTxt, {
      x: valRight - vW,
      y: yPos + 6,
      size: 12,
      font: jpFont,
    });
  };
  yPos -= 8;
  drawRightRow("小計（税抜）", subTotal);
  drawRightRow("消費税（10%）", tax);
  drawRightRow("合計（税込）", grand);

  // 振込先
  const BANK_INFO_Y_START = 100;
  const BANK_INFO_LABEL_X = LEFT + 300;
  const BANK_INFO_TEXT_X = LEFT + 325;
  page.drawText("【振込先】", {
    x: BANK_INFO_LABEL_X,
    y: BANK_INFO_Y_START,
    size: 12,
    font: jpFont,
  });
  ["三菱ＵＦＪ銀行　新大阪支店", "普通　5002177", "サイトウ　ツヨシ"].forEach(
    (txt, i) => {
      page.drawText(txt, {
        x: BANK_INFO_TEXT_X,
        y: BANK_INFO_Y_START - GAP * (i + 1),
        size: 12,
        font: jpFont,
      });
    }
  );

  return pdfDoc.save();
}
