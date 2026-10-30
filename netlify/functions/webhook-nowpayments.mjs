import { env, json, hmac, safeEqualHex, getBookingById, markPaid, setPaymentNote, amountCents, centsToDecimal } from "./_payments.mjs";

// NOWPayments IPN signs the JSON body with sorted keys, HMAC-SHA512.
const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : v;

// NOWPayments -> POST /api/webhooks/nowpayments
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = env("NOWPAYMENTS_IPN_SECRET");
  if (!secret) return json({ error: "Webhook not configured" }, 500);

  let body;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }

  const expected = hmac("sha512", secret, JSON.stringify(sortKeys(body)));
  if (!safeEqualHex(expected, req.headers.get("x-nowpayments-sig") || ""))
    return json({ error: "Bad signature" }, 400);

  const id = body.order_id;
  const found = await getBookingById(id);
  if (!found) return json({ received: true });

  if (body.payment_status === "finished") {
    // Only accept if the invoice amount is the server-side price we asked for.
    if (Number(body.price_amount) === Number(centsToDecimal(amountCents(found.booking)))) {
      await markPaid(id, { method: "crypto", reference: String(body.payment_id), coin: body.pay_currency });
    } else {
      console.error("nowpayments: amount mismatch", id);
    }
  } else if (["partially_paid", "failed", "expired", "refunded"].includes(body.payment_status)) {
    await setPaymentNote(id, { status: body.payment_status, coin: body.pay_currency });
  }
  return json({ received: true });
};

export const config = { path: "/api/webhooks/nowpayments" };
