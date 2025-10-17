// src/app/api/debug/send-test-email/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const to = new URL(req.url).searchParams.get("to");
  if (!to)
    return NextResponse.json(
      { ok: false, error: "missing ?to=" },
      { status: 400 }
    );

  try {
    const html = `
      <div style="font-family:system-ui">
        <h3>Pageit メール送信テスト</h3>
        <p>このメールが届けば Gmail OAuth と SMTP はOKです。</p>
        <p>時刻: ${new Date().toISOString()}</p>
      </div>
    `;
    const info = await sendMail({
      to,
      subject: "【テスト】Pageit メール送信テスト",
      html,
    });
    return NextResponse.json({ ok: true, info });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
