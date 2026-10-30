import {
  json,
  env,
  siteUrl,
  amountCents,
  centsToDecimal,
  availableMethods,
  getBookingById,
  saveBooking,
  paypalBase,
  paypalToken,
} from "./_payments.mjs";

const CRYPTO_COINS = ["btc", "ltc", "usdttrc20", "usdterc20"]; // NOWPayments codes

async function stripeCheckout(id, booking, cents, base) {
  const p = new URLSearchParams({
    mode: "payment",
    success_url: `${base}/payment-success.html?booking=${id}`,
    cancel_url: `${base}/payment-cancelled.html?booking=${id}`,
    client_reference_id: id,
    "metadata[bookingId]": id,
    "payment_intent_data[metadata][bookingId]": id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": `${booking.serviceName} - ${booking.date} ${booking.time}`,
  });
  if (booking.email) p.set("customer_email", booking.email);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: p,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Stripe error");
  return { url: data.url, ref: data.id };
}

async function paypalOrder(id, booking, cents, base) {
  const token = await paypalToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": id },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: id,
          custom_id: id,
          description: `${booking.serviceName} ${booking.date} ${booking.time}`.slice(0, 120),
          amount: { currency_code: "USD", value: centsToDecimal(cents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            return_url: `${base}/api/paypal-return?booking=${id}`,
            cancel_url: `${base}/payment-cancelled.html?booking=${id}`,
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "PayPal error");
  const link = data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new Error("PayPal did not return an approval link");
  return { url: link.href, ref: data.id };
}

async function cryptoInvoice(id, booking, cents, base, coin) {
  const body = {
    price_amount: Number(centsToDecimal(cents)),
    price_currency: "usd",
    order_id: id,
    order_description: `${booking.serviceName} ${booking.date} ${booking.time}`,
    ipn_callback_url: `${base}/api/webhooks/nowpayments`,
    success_url: `${base}/payment-success.html?booking=${id}`,
    cancel_url: `${base}/payment-cancelled.html?booking=${id}`,
  };
  if (coin) body.pay_currency = coin;
  const res = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: { "x-api-key": env("NOWPAYMENTS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.invoice_url) throw new Error(data.message || "Crypto provider error");
  return { url: data.invoice_url, ref: String(data.id) };
}

// GET  /api/pay                      -> which payment methods are switched on
// POST /api/pay {bookingId, method, coin?} -> { url } to send the customer to
export default async (req) => {
  if (req.method === "GET") return json({ methods: availableMethods(), depositPercent: Number(env("DEPOSIT_PERCENT") || 100) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const methods = availableMethods();
  const method = body.method;
  if (!["card", "paypal", "crypto"].includes(method) || !methods[method])
    return json({ error: "That payment method isn't available." }, 400);

  const found = await getBookingById(body.bookingId);
  if (!found) return json({ error: "Booking not found." }, 404);
  const { key, booking } = found;
  if (booking.status === "cancelled") return json({ error: "This booking was cancelled." }, 409);
  if (booking.payment?.status === "paid") return json({ error: "This booking is already paid." }, 409);

  const base = siteUrl();
  if (!base) return json({ error: "Server is missing SITE_URL." }, 500);
  const cents = amountCents(booking);

  try {
    let out;
    if (method === "card") out = await stripeCheckout(body.bookingId, booking, cents, base);
    else if (method === "paypal") out = await paypalOrder(body.bookingId, booking, cents, base);
    else {
      const coin = CRYPTO_COINS.includes(body.coin) ? body.coin : undefined;
      out = await cryptoInvoice(body.bookingId, booking, cents, base, coin);
    }
    booking.payment = { ...booking.payment, status: "awaiting", method, reference: out.ref, expectedCents: cents };
    await saveBooking(key, booking);
    return json({ url: out.url });
  } catch (e) {
    console.error("pay error", method, e.message);
    return json({ error: "Couldn't start the payment. Please try again or contact us." }, 502);
  }
};

export const config = { path: "/api/pay" };
