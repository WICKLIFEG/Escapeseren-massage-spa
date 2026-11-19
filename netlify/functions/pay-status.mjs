import { env, json, hmac, safeEqualHex, getBookingById, markPaid, paystackVerify, paystackMatches } from "./_payments.mjs";

// Paystack -> POST /api/webhooks/paystack
// Backup for when a customer pays but closes the page before being sent back to the site.
// Paystack signs the body with your secret key (HMAC-SHA512) in the x-paystack-signature header.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = env("PAYSTACK_SECRET_KEY");
  if (!secret) return json({ error: "Webhook not configured" }, 500);

  const raw = await req.text();
  if (!safeEqualHex(hmac("sha512", secret, raw), req.headers.get("x-paystack-signature") || ""))
    return json({ error: "Bad signature" }, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ received: true }); }

  if (event.event === "charge.success") {
    const id = event.data?.metadata?.bookingId;
    const found = await getBookingById(id);
    if (found && found.booking.payment?.method === "card" && found.booking.payment.reference === event.data.reference) {
      try {
        const data = await paystackVerify(event.data.reference);
        if (paystackMatches(data, found.booking)) await markPaid(id, { method: "card" });
        else console.error("paystack webhook: verify mismatch", id);
      } catch (e) {
        console.error("paystack webhook error", e.message);
      }
    }
  }
  return json({ received: true });
};

export const config = { path: "/api/webhooks/paystack" };
