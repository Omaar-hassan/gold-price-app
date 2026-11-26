import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice } from "../lib/goldPrice.server";
import { loadSettings } from "../lib/store.server";
import { shopifyConnector } from "../lib/connectors/shopify.server";

// Polled by the dashboard every 30 seconds to keep the live price fresh, in the
// store's own currency.
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopInfo = await shopifyConnector(admin, session.shop).getStoreInfo();
  const currency =
    shopInfo.currency ||
    (await loadSettings(admin, session.shop)).currency ||
    "USD";
  const live = await getLiveGoldPrice(currency);
  return json(live, { headers: { "Cache-Control": "no-store" } });
};
