import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify's mandatory privacy (GDPR) webhooks. Required for the App Store.
// authenticate.webhook checks Shopify's signature and answers 401 if it is wrong.
//
// - customers/data_request and customers/redact: this app stores no customer
//   data (only products, prices and settings), so there is nothing to send or delete.
// - shop/redact: sent 48 hours after a store uninstalls the app. Delete everything
//   stored for that store.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await db.$transaction([
      db.priceRun.deleteMany({ where: { shop } }),
      db.shopSettings.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
