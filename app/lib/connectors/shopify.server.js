// The Shopify connector. It wraps the Admin API helpers in ../store.server.js,
// which keep doing the actual work (queries, paging, retries), so moving Shopify
// behind the connector interface changes no behavior.
import { assertConnector } from "./index";
import {
  applyPrices,
  fetchAllProducts,
  fetchShopInfo,
  fetchVariantPrices,
  saveProductFix,
} from "../store.server";

/** admin: the Admin API client from authenticate.admin or unauthenticated.admin. */
export function shopifyConnector(admin, shop) {
  return assertConnector({
    id: "shopify",
    name: "Shopify",
    storeId: shop,
    capabilities: { productFix: true, taxSetting: true },
    getStoreInfo: () => fetchShopInfo(admin, shop),
    listProducts: () => fetchAllProducts(admin),
    getPrices: (variantIds) => fetchVariantPrices(admin, variantIds),
    setPrices: (changes) => applyPrices(admin, changes),
    saveProductFix: (productId, variantId, fix) =>
      saveProductFix(admin, productId, variantId, fix),
  });
}
