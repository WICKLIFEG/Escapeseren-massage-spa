import { siteUrl, redirect, getBookingById, markPaid, paystackVerify, paystackMatches } from "./_payments.mjs";

// Paystack sends the customer back here after the card page (?booking=ID).
// We ask Paystack directly whether the payment succeeded, for the exact amount, before marking it paid.
export default async (req) => {
  const bookingId = new URL(req.url).searchParams.get("booking");
  const site = siteUrl();
  const fail = () => redirect(`${site}/payment-cancelled.html?booking=${encodeURIComponent(bookingId || "")}`);
  const ok = () => redirect(`${site}/payment-success.html?booking=${bookingId}`);

  const found = await getBookingById(bookingId);
  if (!found) return fail();
  const { booking } = found;
  if (booking.payment?.method !== "card" || !booking.payment?.reference) return fail();
  if (booking.payment.status === "paid") return ok();

  try {
    const data = await paystackVerify(booking.payment.reference);
    if (!paystackMatches(data, booking)) return fail();
    await markPaid(bookingId, { method: "card" });
    return ok();
  } catch (e) {
    console.error("paystack verify error", e.message);
    return fail();
  }
};

export const config = { path: "/api/paystack-return" };
