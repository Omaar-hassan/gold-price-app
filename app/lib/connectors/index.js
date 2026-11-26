// Store connectors: the one place the app talks to a shop system (Shopify today,
// WooCommerce and Odoo next). Pricing, preview, apply, undo, restore and automatic
// updates only use this interface, so a new shop system means one new connector
// file, not changes all over the app.
//
// A connector is an object with:
//   id            "shopify" | "woocommerce" | "odoo" ...
//   name          Shown to the merchant, e.g. "Shopify".
//   storeId       Which store it is connected to (Shopify: the myshopify domain).
//   capabilities  { productFix: bool, taxSetting: bool }
//                 productFix: can save karat/origin/weight fixes on a product.
//                 taxSetting: knows whether its prices include tax.
//
//   getStoreInfo()          -> { currency, taxesIncluded, timeZone }
//                              currency: ISO code or null if it could not be read.
//                              taxesIncluded: true | false | null (unknown).
//   listProducts()          -> [Product]  every product, all variants (see below).
//   getPrices(variantIds)   -> Map(variantId -> current price as a number).
//                              A variant that no longer exists is missing.
//   setPrices(changes)      -> { updated: [change], errors: [{ productId,
//                              productTitle, message }] }
//                              changes: [{ productId, variantId, newPrice,
//                              currentPrice, productTitle, variantTitle }].
//                              Must be safe to repeat (sets a value).
//   saveProductFix(productId, variantId, fix)   only if capabilities.productFix.
//
// Product (the shape app/lib/pricing.js reads):
//   { id, title, status, productType, tags: [string], image: url|null,
//     metafields: [{ namespace, key, value }],      // extra fields, may be []
//     variants: [{ id, title, price, sku, weightGrams, fixWeight }] }
// IDs are strings unique within the store. Prices are in the store currency.
//
// Plan (Nov 2026): the Shopify app is the home. WooCommerce and Odoo stores are
// connected from inside it as extra stores. A standalone web app for merchants
// without Shopify may come later, so connectors and app/lib/pricing.js must not
// depend on a Shopify login: a connector gets everything it needs (API client or
// keys) when it is created.

export const REQUIRED_METHODS = [
  "getStoreInfo",
  "listProducts",
  "getPrices",
  "setPrices",
];

/** Throws if `connector` is missing part of the interface (used in tests). */
export function assertConnector(connector) {
  const missing = [];
  for (const key of ["id", "name", "storeId"])
    if (!connector?.[key]) missing.push(key);
  for (const m of REQUIRED_METHODS)
    if (typeof connector?.[m] !== "function") missing.push(`${m}()`);
  if (!connector?.capabilities) missing.push("capabilities");
  if (
    connector?.capabilities?.productFix &&
    typeof connector.saveProductFix !== "function"
  )
    missing.push("saveProductFix()");
  if (missing.length)
    throw new Error(`Connector is missing: ${missing.join(", ")}`);
  return connector;
}
