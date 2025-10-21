import { sendMail } from "@/lib/mailer";
import { safeErr } from "./stripeUtils";
import { logOrderMail } from "./firestoreUtils";

export async function sendOwnerMail({
  siteKey,
  ownerEmail,
  html,
  sessionId,
  eventType,
}: {
  siteKey: string;
  ownerEmail: string;
  html: string;
  sessionId: string;
  eventType: string;
}) {
  try {
    await sendMail({
      to: ownerEmail,
      subject: "【注文通知】新しい注文が完了しました",
      html,
    });
    await logOrderMail({
      siteKey,
      ownerEmail,
      sessionId,
      eventType,
      sent: true,
    });
  } catch (e) {
    await logOrderMail({
      siteKey,
      ownerEmail,
      sessionId,
      eventType,
      sent: false,
      reason: `sendMail failed: ${safeErr(e)}`,
    });
  }
}
