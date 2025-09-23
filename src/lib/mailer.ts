// src/lib/mailer.ts
import nodemailer from "nodemailer";
import { google } from "googleapis";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_SENDER_EMAIL,       // ← ここを使う
  GOOGLE_REDIRECT_URI,       // OAuth Playground の URI
} = process.env;

// 起動時に不足していないかチェック
(() => {
  const missing: string[] = [];
  if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!GOOGLE_REFRESH_TOKEN) missing.push("GOOGLE_REFRESH_TOKEN");
  if (!GOOGLE_SENDER_EMAIL) missing.push("GOOGLE_SENDER_EMAIL");
  if (missing.length) {
    console.warn(`[mailer] Missing env vars: ${missing.join(", ")}`);
  }
})();

// OAuth2 クライアント
const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI || undefined
);
if (GOOGLE_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}

export type Mail = {
  to: string | string[];
  subject: string;
  html: string;
  bcc?: string | string[];
  replyTo?: string;
};

function buildFromAddress(): string {
  const addr = GOOGLE_SENDER_EMAIL!;
  return /^".*"\s*<.+>$/.test(addr) ? addr : `"Pageit Orders" <${addr}>`;
}

export async function sendMail({ to, subject, html, bcc, replyTo }: Mail) {
  // アクセストークン取得
  let accessToken: string | null = null;
  try {
    const r = await oAuth2Client.getAccessToken();
    accessToken = r?.token ?? null;
  } catch (e) {
    console.error("[mailer] getAccessToken failed:", e);
    throw new Error("[mailer] Failed to acquire Google OAuth2 access token");
  }
  if (!accessToken) {
    throw new Error("[mailer] Empty access token from Google OAuth2");
  }

  // Nodemailer トランスポート
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      type: "OAuth2",
      user: GOOGLE_SENDER_EMAIL!,
      clientId: GOOGLE_CLIENT_ID!,
      clientSecret: GOOGLE_CLIENT_SECRET!,
      refreshToken: GOOGLE_REFRESH_TOKEN!,
      accessToken,
    },
    pool: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as nodemailer.TransportOptions);

  // 送信
  const from = buildFromAddress();
  await transporter.sendMail({
    from,
    to,
    bcc,
    subject,
    html,
    replyTo,
  });
}
