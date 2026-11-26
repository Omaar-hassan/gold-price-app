import test from "node:test";
import assert from "node:assert/strict";
import { assertConnector } from "../app/lib/connectors/index.js";
import {
  buildPlan,
  karatPrices,
  normalizeSettings,
  splitByCurrentPrice,
} from "../app/lib/pricing.js";

// A tiny in-memory store that follows the connector interface. It shows what a new
// connector (WooCommerce, Odoo) has to provide, and that pricing needs nothing more.
function memoryConnector() {
  const prices = new Map([["v1", 18000]]);
  return {
    id: "memory",
    name: "Test store",
    storeId: "test",
    capabilities: { productFix: false, taxSetting: false },
    getStoreInfo: async () => ({
      currency: "EGP",
      taxesIncluded: null,
      timeZone: "Africa/Cairo",
    }),
    listProducts: async () => [
      {
        id: "p1",
        title: "Ring 21k Local 5g",
        status: "ACTIVE",
        productType: "",
        tags: [],
        image: null,
        metafields: [],
        variants: [
          {
            id: "v1",
            title: "",
            price: String(prices.get("v1")),
            sku: "",
            weightGrams: null,
            fixWeight: null,
          },
        ],
      },
    ],
    getPrices: async (ids) =>
      new Map(
        ids.filter((id) => prices.has(id)).map((id) => [id, prices.get(id)]),
      ),
    setPrices: async (changes) => {
      for (const c of changes) prices.set(c.variantId, Number(c.newPrice));
      return { updated: changes, errors: [] };
    },
  };
}

test("assertConnector accepts a complete connector", () => {
  assert.doesNotThrow(() => assertConnector(memoryConnector()));
});

test("assertConnector lists what is missing", () => {
  const c = memoryConnector();
  delete c.setPrices;
  c.capabilities.productFix = true;
  assert.throws(
    () => assertConnector(c),
    /missing: setPrices\(\), saveProductFix\(\)/,
  );
});

test("preview and apply work through any connector", async () => {
  const store = assertConnector(memoryConnector());
  const settings = normalizeSettings({
    making: { 21: { local: 100, imported: 100 } },
  });
  const prices = karatPrices(
    { usdPerOunce: 3110.34768, usdRate: 50 },
    settings,
  );
  const plan = buildPlan(await store.listProducts(), settings, prices, {
    taxesIncluded: (await store.getStoreInfo()).taxesIncluded,
  });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].newPrice, (4375 + 100) * 5);

  const current = await store.getPrices(plan.rows.map((r) => r.variantId));
  const { safe } = splitByCurrentPrice(plan.rows, current, "currentPrice");
  const result = await store.setPrices(safe);
  assert.equal(result.updated.length, 1);
  assert.equal((await store.getPrices(["v1"])).get("v1"), 22375);
});
