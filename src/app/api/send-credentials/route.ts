// app/api/send-credentials/route.ts
import { google } from "googleapis";
import { NextRequest, NextResponse } from "next/server";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_REDIRECT_URI,
  GOOGLE_SENDER_EMAIL,
} = process.env;

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();

  if (!email || !password) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // 件名をMIMEエンコード（Base64）
  const subject = "ログイン情報のご案内";
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString(
    "base64"
  )}?=`;

  const message = [
    `From: Pageit <${GOOGLE_SENDER_EMAIL}>`,
    `To: ${email}`,
    `Subject: ${encodedSubject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    `以下のログイン情報をご利用ください。`,
    ``,
    `メールアドレス: ${email}`,
    `初回ログインパスワード: ${password}`,
    ``,
    `ログイン後、パスワードの変更をおすすめします。`,
    `また、ログイン後にホームページ内容の編集が可能になります。`,
  ].join("\r\n");

  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Gmail送信エラー:", error);
    return NextResponse.json({ error: "Failed to send" }, { status: 500 });
  }
}
