import { SERVICES, json, isValidDate, freeStarts } from "./_lib.mjs";

// GET /api/availability?date=YYYY-MM-DD&service=swedish
export default async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const date = url.searchParams.get("date");
  const service = SERVICES[url.searchParams.get("service")];

  if (!isValidDate(date)) return json({ error: "Invalid date (use YYYY-MM-DD)" }, 400);
  if (!service) return json({ error: "Unknown service" }, 400);

  const slots = await freeStarts(date, service);
  return json({ date, service: service.name, slots });
};

export const config = { path: "/api/availability" };
