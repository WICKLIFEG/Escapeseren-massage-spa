import { siteUrl, redirect, getBookingById, markPaid, amountCents, centsToDecimal, paypalBase, paypalToken } from "./_payments.mjs";

const base = paypalBase;

// PayPal sends the customer back here after approval (?booking=ID&token=ORDER_ID).
// We capture the money server-side and verify it before marking the booking paid.
export default async (req) => {
  const url = new URL(req.url);
  const bookingId = url.searchParams.get("booking");
  const orderId = url.searchParams.get("token");
  const site = siteUrl();
  const fail = () => redirect(`${site}/payment-cancelled.html?booking=${encodeURIComponent(bookingId || "")}`);

  const found = await getBookingById(bookingId);
  if (!found || !orderId) return fail();
  const { booking } = found;
  // The order must be the one we created for this booking.
  if (booking.payment?.method !== "paypal" || booking.payment?.reference !== orderId) return fail();
  if (booking.payment?.status === "paid") return redirect(`${site}/payment-success.html?booking=${bookingId}`);

  try {
    const token = await paypalToken();
    const res = await fetch(`${base()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const data = await res.json();
    const unit = data.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const ok =
      data.status === "COMPLETED" &&
      capture?.status === "COMPLETED" &&
      unit?.custom_id === bookingId &&
      capture.amount?.currency_code === "USD" &&
      capture.amount?.value === centsToDecimal(amountCents(booking));
    if (!ok) return fail();
    await markPaid(bookingId, { method: "paypal", reference: capture.id });
    return redirect(`${site}/payment-success.html?booking=${bookingId}`);
  } catch (e) {
    console.error("paypal capture error", e.message);
    return fail();
  }
};

export const config = { path: "/api/paypal-return" };
