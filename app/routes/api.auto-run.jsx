// Called every few minutes by an outside timer (for example cron-job.org) to run the
// automatic price updates that are due. Protected by the CRON_SECRET environment
// variable, sent as the header "Authorization: Bearer <CRON_SECRET>".
// It answers at once and does the work in the background, so a slow store never
// makes the timer give up.
import { timingSafeEqual } from "node:crypto";
import { json } from "@remix-run/node";
import { runDueShops } from "../lib/auto.server";

function authorized(request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 16) return false;
  const header = request.headers.get("authorization") || "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request) {
  if (!process.env.CRON_SECRET)
    return json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!authorized(request))
    return json({ error: "Unauthorized" }, { status: 401 });
  runDueShops().catch((error) =>
    console.error("[gold-price] automatic updates failed:", error),
  );
  return json({ ok: true }, { status: 202 });
}

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
