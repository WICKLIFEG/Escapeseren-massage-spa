import { randomUUID } from "node:crypto";
import {
  SERVICES,
  json,
  store,
  isValidDate,
  freeStarts,
  hoursNeeded,
  lockKey,
  hh,
} from "./_lib.mjs";

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// POST /api/book
// Body: { service, date, time, name, phone, email?, notes?, website? }
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Honeypot: real visitors never fill this hidden field. Pretend success to bots.
  if (clean(body.website, 100)) return json({ ok: true }, 201);

  const service = SERVICES[body.service];
  const date = clean(body.date, 10);
  const time = clean(body.time, 5);
  const name = clean(body.name, 80);
  const phone = clean(body.phone, 30);
  const email = clean(body.email, 120);
  const notes = clean(body.notes, 500);

  if (!service) return json({ error: "Please choose a service." }, 400);
  if (!isValidDate(date)) return json({ error: "Please choose a valid date." }, 400);
  if (!/^\d{2}:00$/.test(time)) return json({ error: "Please choose a valid time." }, 400);
  if (name.length < 2) return json({ error: "Please enter your name." }, 400);
  if (!/^[+\d][\d\s()-]{6,}$/.test(phone))
    return json({ error: "Please enter a valid phone number." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: "Please enter a valid email." }, 400);

  // Is the requested start time still offered?
  const open = await freeStarts(date, service);
  if (!open.includes(time))
    return json({ error: "Sorry, that time is no longer available. Please pick another." }, 409);

  // Claim every hour the service needs. onlyIfNew makes the claim atomic,
  // so two people can't grab the same slot at once.
  const s = store();
  const id = randomUUID();
  const start = Number(time.slice(0, 2));
  const hours = Array.from({ length: hoursNeeded(service) }, (_, i) => start + i);
  const claimed = [];
  for (const h of hours) {
    const res = await s.setJSON(lockKey(date, h), { booking: id }, { onlyIfNew: true });
    if (res && res.modified === false) {
      await Promise.all(claimed.map((k) => s.delete(k))); // roll back
      return json({ error: "Sorry, that time was just taken. Please pick another." }, 409);
    }
    claimed.push(lockKey(date, h));
  }

  const booking = {
    id,
    service: body.service,
    serviceName: service.name,
    price: service.price,
    minutes: service.minutes,
    date,
    time,
    hours,
    name,
    phone,
    email,
    notes,
    status: "pending",
    payment: { status: "unpaid" },
    createdAt: new Date().toISOString(),
  };
  const key = `booking/${date}/${hh(start)}-${id}`;
  await s.setJSON(key, booking);
  await s.setJSON(`byid/${id}`, { key }); // lookup index used by the payment endpoints

  return json(
    {
      ok: true,
      id,
      message: `Thank you ${name}! Your ${service.name} request for ${date} at ${time} was received. We will confirm shortly.`,
    },
    201
  );
};

export const config = { path: "/api/book" };
