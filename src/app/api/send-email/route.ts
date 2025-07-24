/* ------------------------------------------------------------------ */
/*  app/api/send-email/route.ts                                       */
/* ------------------------------------------------------------------ */
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

export async function POST(req: NextRequest) {
  try {
    const {
      to,
      name,
      subject = "【Pageit】振込のご案内",
      body,
      invoiceDate,
      dueDate,
      setupSelected,
      shootingSelected,
    } = await req.json();

    if (!to || !name || (!setupSelected && !shootingSelected)) {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    const setupPrice = 30000;
    const shootingPrice = 50000;

    const now = new Date();
    const invDate = invoiceDate ?? now.toLocaleDateString("ja-JP");
    const dueDateJP =
      dueDate ??
      new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString(
        "ja-JP"
      );

    const pdfBytes = await createInvoicePdf({
      customerName: name,
      setupSelected,
      shootingSelected,
      setupPrice,
      shootingPrice,
      invoiceNumber: INVOICE_ID,
      invoiceDate: invDate,
      dueDate: dueDateJP,
      logoPath: "public/images/xenoLogo.png",
      itemIconPath: "public/images/logo.png",
    });

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
      from: `Pageit運営 <${GOOGLE_SENDER_EMAIL}>`,
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
