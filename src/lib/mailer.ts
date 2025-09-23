// src/lib/mailer.ts
import nodemailer from "nodemailer";
import { google } from "googleapis";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  SENDER_EMAIL,
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !SENDER_EMAIL) {
  // 起動時に気づけるように
  console.warn("[mailer] Missing Gmail OAuth2 env vars.");
}

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
);
// 予め取得してあるリフレッシュトークンをセット
oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

export type Mail = {
  to: string | string[];
  subject: string;
  html: string;
  bcc?: string | string[];
  replyTo?: string;
};

export async function sendMail({ to, subject, html, bcc, replyTo }: Mail) {
  // アクセストークンを動的に取得
  const { token } = await oAuth2Client.getAccessToken();

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: SENDER_EMAIL,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      refreshToken: GOOGLE_REFRESH_TOKEN,
      accessToken: token || undefined,
    },
  });

  await transporter.sendMail({
    from: SENDER_EMAIL,
    to,
    bcc,
    subject,
    html,
    replyTo,
  });
}
