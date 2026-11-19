import { createHmac, timingSafeEqual } from "node:crypto";
import { store, json } from "./_lib.mjs";

export const env = (k) => process.env[k] || "";
export const siteUrl = () => (env("SITE_URL") || env("URL") || "").replace(/\/$/, "");

// Share of the price charged online: 100 = full price, 30 = 30% deposit.
export const depositPercent = () => {
  const n = Number(env("DEPOSIT_PERCENT") || 100);
  return n > 0 && n <= 100 ? n : 100;
};

// The amount ALWAYS comes from the server-side price list, never from the browser.
export const amountCents = (booking) =>
  Math.round(booking.price * 100 * (depositPercent() / 100));
export const centsToDecimal = (c) => (c / 100).toFixed(2);

export function availableMethods() {
  return {
    card: !!env("PAYSTACK_SECRET_KEY"), // Visa / Mastercard via Paystack (pays out in Kenya)
    paypal: !!(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")),
    crypto: !!env("NOWPAYMENTS_API_KEY"), // BTC, LTC, USDT
    mpesa: !!(
      env("MPESA_CONSUMER_KEY") &&
      env("MPESA_CONSUMER_SECRET") &&
      env("MPESA_SHORTCODE") &&
      env("MPESA_PASSKEY") &&
      env("MPESA_CALLBACK_SECRET").length >= 12
    ),
  };
}

// ---------- Card payments (Paystack) ----------
export async function paystackVerify(reference) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${env("PAYSTACK_SECRET_KEY")}` },
  });
  const j = await res.json().catch(() => ({}));
  return res.ok && j.status === true ? j.data : null;
}

// Counts only if Paystack says it succeeded, in KES, for exactly the amount we asked for.
export const paystackMatches = (data, booking) =>
  !!data &&
  data.status === "success" &&
  data.currency === "KES" &&
  data.reference === booking.payment?.reference &&
  data.amount === booking.payment?.expectedKes * 100;

// ---------- M-Pesa (Safaricom Daraja) ----------
export const mpesaBase = () =>
  env("MPESA_ENV") === "live" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

// M-Pesa charges whole Kenyan shillings. Rate = KES per 1 USD (set KES_PER_USD).
export const kesAmount = (cents) => Math.ceil((cents / 100) * Number(env("KES_PER_USD") || 130));

// Accepts 07XXXXXXXX, 01XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX -> 2547XXXXXXXX
export function normalizeKenyanPhone(input) {
  const d = String(input || "").replace(/[^\d]/g, "");
  let n = d;
  if (/^0[17]\d{8}$/.test(d)) n = "254" + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) n = "254" + d;
  return /^254[17]\d{8}$/.test(n) ? n : null;
}

export async function mpesaToken() {
  const auth = Buffer.from(`${env("MPESA_CONSUMER_KEY")}:${env("MPESA_CONSUMER_SECRET")}`).toString("base64");
  const res = await fetch(`${mpesaBase()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("M-Pesa auth failed");
  return data.access_token;
}

export function mpesaTimestamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export const mpesaPassword = (timestamp) =>
  Buffer.from(`${env("MPESA_SHORTCODE")}${env("MPESA_PASSKEY")}${timestamp}`).toString("base64");

export async function getBookingById(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const s = store();
  const idx = await s.get(`byid/${id}`, { type: "json" });
  if (!idx) return null;
  const booking = await s.get(idx.key, { type: "json" });
  return booking ? { key: idx.key, booking } : null;
}

export async function saveBooking(key, booking) {
  await store().setJSON(key, booking);
}

// Idempotent: safe if a provider sends the same notification twice.
export async function markPaid(id, info) {
  const found = await getBookingById(id);
  if (!found) return { ok: false, reason: "not_found" };
  const { key, booking } = found;
  if (booking.payment?.status === "paid") return { ok: true, already: true };
  if (booking.status === "cancelled") return { ok: false, reason: "cancelled" };
  booking.payment = { ...booking.payment, ...info, status: "paid", paidAt: new Date().toISOString() };
  if (booking.status === "pending") booking.status = "confirmed";
  booking.updatedAt = new Date().toISOString();
  await saveBooking(key, booking);
  return { ok: true };
}

export async function setPaymentNote(id, patch) {
  const found = await getBookingById(id);
  if (!found) return;
  const { key, booking } = found;
  if (booking.payment?.status === "paid") return;
  booking.payment = { ...booking.payment, ...patch };
  await saveBooking(key, booking);
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmac = (algo, secret, data) => createHmac(algo, secret).update(data).digest("hex");

export const paypalBase = () =>
  env("PAYPAL_ENV") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export async function paypalToken() {
  const auth = Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error("PayPal auth failed");
  return data.access_token;
}

export const redirect = (url) => new Response(null, { status: 303, headers: { location: url } });
export { json };
