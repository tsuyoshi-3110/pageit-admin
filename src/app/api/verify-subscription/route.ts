import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ status: "none" }, { status: 400 });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
    const sub: any = session.subscription;

    const status =
      sub && typeof sub === "object" && "status" in sub
        ? sub.status === "active" || sub.status === "trialing"
          ? "active"
          : sub.status === "canceled"
          ? "canceled"
          : "none"
        : "none";

    return NextResponse.json({ status });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ status: "none" }, { status: 500 });
  }
}
