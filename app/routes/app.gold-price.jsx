import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice } from "../lib/goldPrice.server";

// Polled by the dashboard every 30 seconds to keep the live price fresh.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const live = await getLiveGoldPrice();
  return json(live, { headers: { "Cache-Control": "no-store" } });
};
