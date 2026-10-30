import { env, json, hmac, safeEqualHex, getBookingById, markPaid, amountCents } from "./_payments.mjs";

// Stripe -> POST /api/webhooks/stripe  (event: checkout.session.completed)
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook not configured" }, 500);

  const raw = await req.text();
  const header = req.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = parts.t;
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300)
    return json({ error: "Bad signature" }, 400);
  if (!safeEqualHex(hmac("sha256", secret, `${t}.${raw}`), parts.v1))
    return json({ error: "Bad signature" }, 400);

  const event = JSON.parse(raw);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const id = s.client_reference_id || s.metadata?.bookingId;
    const found = await getBookingById(id);
    if (found && s.payment_status === "paid" && s.currency === "usd" && s.amount_total === amountCents(found.booking)) {
      await markPaid(id, { method: "card", reference: s.payment_intent || s.id });
    } else {
      console.error("stripe webhook: mismatch or unpaid", id);
    }
  }
  return json({ received: true });
};

export const config = { path: "/api/webhooks/stripe" };
