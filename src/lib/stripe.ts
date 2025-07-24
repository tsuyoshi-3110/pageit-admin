import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // ← apiVersion は書かない（最新SDKに任せる）
});
