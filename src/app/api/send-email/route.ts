export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import nodemailer from "nodemailer";
import { createInvoicePdf } from "@/lib/createInvoicePdf";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_SENDER_EMAIL,
  GOOGLE_REDIRECT_URI = "https://developers.google.com/oauthplayground",
} = process.env;

const INVOICE_ID = "T4120001209252";
const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

export async function POST(req: NextRequest) {
  try {
    const {
      to,
      name,
      subject = "【Pageit】請求書（銀行振込／カード決済のご案内）",
      body,
      invoiceDate,
      dueDate,

      // 選択・数量（5商品）
      setupSelected,
      shootingSelected, // 撮影編集代行
      satueiSelected,   // 撮影代行
      henshuSelected,   // 編集代行
      fullSelected,     // フルセット
      setupQty = 0,
      shootingQty = 0,
      satueiQty = 0,
      henshuQty = 0,
      fullQty = 0,
    } = await req.json();

    if (!to || !name) {
      return NextResponse.json({ error: "to/name missing" }, { status: 400 });
    }

    // 価格（送信側と整合）
    const setupPrice = 30000;
    const shootingPrice = 50000;
    const satueiPrice = 35000;
    const henshuPrice = 15000;
    const fullPrice = 80000;

    // PDF用アイテム（数量>0 のみ採用）
    const items = [
      setupSelected && setupQty > 0
        ? { label: "初期設定", unitPrice: setupPrice, qty: Number(setupQty) }
        : null,
      shootingSelected && shootingQty > 0
        ? { label: "撮影編集代行", unitPrice: shootingPrice, qty: Number(shootingQty) }
        : null,
      satueiSelected && satueiQty > 0
        ? { label: "撮影代行", unitPrice: satueiPrice, qty: Number(satueiQty) }
        : null,
      henshuSelected && henshuQty > 0
        ? { label: "編集代行", unitPrice: henshuPrice, qty: Number(henshuQty) }
        : null,
      fullSelected && fullQty > 0
        ? { label: "フルセット", unitPrice: fullPrice, qty: Number(fullQty) }
        : null,
    ].filter(Boolean) as { label: string; unitPrice: number; qty: number }[];

    if (items.length === 0) {
      return NextResponse.json({ error: "No items" }, { status: 400 });
    }

    const now = new Date();
    const invDate = invoiceDate ?? now.toLocaleDateString("ja-JP");
    const dueDateJP =
      dueDate ??
      new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString("ja-JP");

    // PDF生成
    const pdfBytes = await createInvoicePdf({
      customerName: name,
      invoiceNumber: INVOICE_ID,
      invoiceDate: invDate,
      dueDate: dueDateJP,
      logoPath: `${baseUrl}/images/xenoLogo.png`,
      itemIconPath: `${baseUrl}/images/logo.png`,
      items,
    });

    // Gmail OAuth2
    const oAuth2 = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
    oAuth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    const { token: accessToken } = await oAuth2.getAccessToken();
    if (!accessToken) throw new Error("アクセストークン取得失敗");

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: GOOGLE_SENDER_EMAIL,
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        refreshToken: GOOGLE_REFRESH_TOKEN,
        accessToken,
      },
    });

    await transporter.sendMail({
      from: `Xenovant運営 <${GOOGLE_SENDER_EMAIL}>`,
      to,
      subject,
      text:
        body ??
        `${name} 様\n\n請求書（インボイス登録番号：${INVOICE_ID}）を添付いたしますのでご確認ください。\n` +
          `ご不明点がありましたらお気軽にご連絡ください。`,
      attachments: [
        {
          filename: `請求書_${invDate.replace(/\//g, "-")}.pdf`,
          content: Buffer.from(pdfBytes),
        },
      ],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("メール送信エラー:", error);
    return NextResponse.json(
      { success: false, error: "送信に失敗しました" },
      { status: 500 }
    );
  }
}
