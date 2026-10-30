import { json, store, isAdmin, STATUSES, lockKey } from "./_lib.mjs";

// GET   /api/admin/bookings            -> list all bookings
// PATCH /api/admin/bookings            -> { key, status } update a booking's status
// Requires header: Authorization: Bearer <ADMIN_PASSWORD>
export default async (req) => {
  if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
  const s = store();

  if (req.method === "GET") {
    const { blobs } = await s.list({ prefix: "booking/" });
    const items = await Promise.all(
      blobs.map(async (b) => {
        const data = await s.get(b.key, { type: "json" });
        return data ? { key: b.key, ...data } : null;
      })
    );
    const bookings = items
      .filter(Boolean)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return json({ bookings });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const { key, status } = body;
    if (typeof key !== "string" || !key.startsWith("booking/"))
      return json({ error: "Invalid key" }, 400);
    if (!STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);

    const booking = await s.get(key, { type: "json" });
    if (!booking) return json({ error: "Booking not found" }, 404);
    if (booking.status === "cancelled")
      return json({ error: "Cancelled bookings can't be changed. Ask the client to rebook." }, 409);

    booking.status = status;
    booking.updatedAt = new Date().toISOString();
    await s.setJSON(key, booking);

    // Cancelling frees the time slots again.
    if (status === "cancelled") {
      await Promise.all(booking.hours.map((h) => s.delete(lockKey(booking.date, h))));
    }
    return json({ ok: true, booking: { key, ...booking } });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/admin/bookings" };
