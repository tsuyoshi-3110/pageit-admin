import { NextRequest } from "next/server";
import Stripe from "stripe";
import { stripeConnect } from "@/lib/stripe-connect";
import {
  findSiteKeyByCustomerId,
  findSiteKeyByConnectAccount,
  getOwnerEmail,
} from "./helpers/firestoreUtils";
import { buildOwnerHtmlJa } from "./helpers/htmlTemplates";
import { sendOwnerMail } from "./helpers/mailUtils";
import { safeErr } from "./helpers/stripeUtils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("OK", { status: 200 });

  let event: Stripe.Event;
  try {
    event = stripeConnect.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Signature error:", safeErr(err));
    return new Response("OK", { status: 200 });
  }

  if (event.type !== "checkout.session.completed")
    return new Response("OK", { status: 200 });

  const session = event.data.object as Stripe.Checkout.Session;
  const connectedAccountId = (event as any).account;

  try {
    const siteKey =
      session.metadata?.siteKey ||
      (await findSiteKeyByConnectAccount(connectedAccountId)) ||
      (session.customer
        ? await findSiteKeyByCustomerId(session.customer as string)
        : null);

    if (siteKey) {
      const ownerEmail = await getOwnerEmail(siteKey);
      if (ownerEmail) {
        const html = buildOwnerHtmlJa(session, []);
        await sendOwnerMail({
          siteKey,
          ownerEmail,
          html,
          sessionId: session.id,
          eventType: event.type,
        });
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", safeErr(err));
    return new Response("OK", { status: 200 });
  }
}
