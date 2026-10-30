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
    card: !!env("STRIPE_SECRET_KEY"), // Visa, Mastercard, Amex, Apple/Google Pay
    paypal: !!(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")),
    crypto: !!env("NOWPAYMENTS_API_KEY"), // BTC, LTC, USDT
  };
}

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
