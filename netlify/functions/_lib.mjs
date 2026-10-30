import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

export const TZ = "America/Los_Angeles";
export const OPEN_HOUR = 9; // 9 AM
export const CLOSE_HOUR = 20; // 8 PM (last booking must END by this hour)
export const CLOSED_DAYS = [0]; // 0 = Sunday (open Mon-Sat)

// Keys must match the service ids used by your booking form.
export const SERVICES = {
  swedish: { name: "Swedish Massage", price: 120, minutes: 60 },
  "deep-tissue": { name: "Deep Tissue Massage", price: 150, minutes: 60 },
  facial: { name: "Signature Radiance Facial", price: 130, minutes: 50 },
  "spa-escape": { name: "Ultimate Spa Escape", price: 280, minutes: 120 },
};

export const STATUSES = ["pending", "confirmed", "completed", "cancelled"];

export const store = () => getStore({ name: "spa", consistency: "strong" });

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Current date (YYYY-MM-DD) and hour in the spa's timezone.
export function nowInSpaTime() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
  };
}

export function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const dayOfWeek = (s) => new Date(`${s}T12:00:00Z`).getUTCDay();
export const hoursNeeded = (service) => Math.ceil(service.minutes / 60);
export const hh = (h) => `${String(h).padStart(2, "0")}:00`;
export const lockKey = (date, hour) => `slot/${date}/${hh(hour)}`;

// Hours already taken on a date, read from the slot locks.
export async function takenHours(date) {
  const s = store();
  const { blobs } = await s.list({ prefix: `slot/${date}/` });
  return new Set(blobs.map((b) => Number(b.key.split("/").pop().slice(0, 2))));
}

// Start times (e.g. "09:00") that still fit the given service on a date.
export async function freeStarts(date, service) {
  if (CLOSED_DAYS.includes(dayOfWeek(date))) return [];
  const now = nowInSpaTime();
  if (date < now.date) return [];
  const need = hoursNeeded(service);
  const taken = await takenHours(date);
  const out = [];
  for (let start = OPEN_HOUR; start + need <= CLOSE_HOUR; start++) {
    if (date === now.date && start <= now.hour) continue; // already started or too soon
    let free = true;
    for (let h = start; h < start + need; h++) if (taken.has(h)) free = false;
    if (free) out.push(hh(start));
  }
  return out;
}

// Admin auth: "Authorization: Bearer <ADMIN_PASSWORD>"
export function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (expected.length < 8) return false; // refuse weak/missing password
  const header = req.headers.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
