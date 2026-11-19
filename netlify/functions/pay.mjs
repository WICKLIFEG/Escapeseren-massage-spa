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
  mpesaBase,
  mpesaToken,
  mpesaTimestamp,
  mpesaPassword,
  kesAmount,
  normalizeKenyanPhone,
} from "./_payments.mjs";

const CRYPTO_COINS = ["btc", "ltc", "usdttrc20", "usdterc20"]; // NOWPayments codes

// Card payments via Paystack: returns a secure Paystack page for the customer to pay on.
async function paystackInit(id, booking, cents, base) {
  const kes = kesAmount(cents);
  // Paystack allows only letters, numbers, - . = in a reference.
  const reference = `se-${id}-${Date.now().toString(36)}`;
  const email = booking.email || `guest-${id.slice(0, 8)}@${new URL(base).hostname}`;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("PAYSTACK_SECRET_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      amount: kes * 100, // Paystack counts in the smallest unit (cents)
      currency: "KES",
      reference,
      channels: ["card"],
      callback_url: `${base}/api/paystack-return?booking=${id}`,
      metadata: { bookingId: id, service: booking.serviceName },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status || !data.data?.authorization_url) throw new Error(data.message || "Paystack error");
  return { url: data.data.authorization_url, ref: reference, kes };
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

// Sends the M-Pesa prompt (STK Push) to the customer's phone.
async function mpesaPush(id, booking, kes, phone, base) {
  const token = await mpesaToken();
  const ts = mpesaTimestamp();
  const isTill = env("MPESA_TYPE") === "till"; // "till" = Buy Goods, otherwise Paybill
  const shortcode = env("MPESA_SHORTCODE");
  const res = await fetch(`${mpesaBase()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: mpesaPassword(ts),
      Timestamp: ts,
      TransactionType: isTill ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      Amount: kes,
      PartyA: phone,
      PartyB: isTill ? env("MPESA_TILL") || shortcode : shortcode,
      PhoneNumber: phone,
      // Daraja rejects callback URLs containing words like "mpesa", so this path avoids them.
      CallBackURL: `${base}/api/webhooks/kenya-pay?booking=${id}&k=${encodeURIComponent(env("MPESA_CALLBACK_SECRET"))}`,
      AccountReference: "SereneEscape",
      TransactionDesc: booking.serviceName.slice(0, 20),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ResponseCode !== "0") throw new Error(data.errorMessage || data.ResponseDescription || "M-Pesa error");
  return { ref: data.CheckoutRequestID };
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
  if (!["card", "paypal", "crypto", "mpesa"].includes(method) || !methods[method])
    return json({ error: "That payment method isn't available." }, 400);

  const found = await getBookingById(body.bookingId);
  if (!found) return json({ error: "Booking not found." }, 404);
  const { key, booking } = found;
  if (booking.status === "cancelled") return json({ error: "This booking was cancelled." }, 409);
  if (booking.payment?.status === "paid") return json({ error: "This booking is already paid." }, 409);

  const base = siteUrl();
  if (!base) return json({ error: "Server is missing SITE_URL." }, 500);
  const cents = amountCents(booking);

  if (method === "mpesa") {
    const phone = normalizeKenyanPhone(body.mpesaPhone);
    if (!phone) return json({ error: "Enter a valid Safaricom number, e.g. 0712345678." }, 400);
    const kes = kesAmount(cents);
    try {
      const out = await mpesaPush(body.bookingId, booking, kes, phone, base);
      booking.payment = {
        ...booking.payment,
        status: "awaiting",
        method: "mpesa",
        reference: out.ref,
        expectedCents: cents,
        expectedKes: kes,
        phoneLast4: phone.slice(-4),
      };
      await saveBooking(key, booking);
      return json({ pending: true, kes, message: `Check your phone: enter your M-Pesa PIN to pay KES ${kes}.` });
    } catch (e) {
      console.error("mpesa push error", e.message);
      return json({ error: "Couldn't send the M-Pesa prompt. Check the number and try again." }, 502);
    }
  }

  try {
    let out;
    if (method === "card") out = await paystackInit(body.bookingId, booking, cents, base);
    else if (method === "paypal") out = await paypalOrder(body.bookingId, booking, cents, base);
    else {
      const coin = CRYPTO_COINS.includes(body.coin) ? body.coin : undefined;
      out = await cryptoInvoice(body.bookingId, booking, cents, base, coin);
    }
    booking.payment = {
      ...booking.payment,
      status: "awaiting",
      method,
      reference: out.ref,
      expectedCents: cents,
      ...(out.kes ? { expectedKes: out.kes } : {}),
    };
    await saveBooking(key, booking);
    return json({ url: out.url });
  } catch (e) {
    console.error("pay error", method, e.message);
    return json({ error: "Couldn't start the payment. Please try again or contact us." }, 502);
  }
};

export const config = { path: "/api/pay" };
