import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  computePiecePrice,
  detectVariant,
  karatFromText,
  karatPrices,
  normalizeKarat,
  normalizeSettings,
  originFromText,
  splitByCurrentPrice,
  weightFromMetafield,
  weightFromSku,
  weightWithUnit,
} from "../app/lib/pricing.js";

test("SKU weight uses the last number, not the karat", () => {
  assert.equal(weightFromSku("GLD-21K-LOC-5.5"), 5.5);
  assert.equal(weightFromSku("GLD-18K-3.2"), 3.2);
  assert.equal(weightFromSku("RING-5G"), 5);
  assert.equal(weightFromSku("GLD-21K"), null);
  assert.equal(weightFromSku(""), null);
});

test("titles need an explicit gram unit", () => {
  assert.equal(weightWithUnit("Ring 21k Local"), null);
  assert.equal(weightWithUnit("خاتم ذهب 21k محلي 5 جرام"), 5);
  assert.equal(weightWithUnit("Chain 12.5 grams"), 12.5);
  assert.equal(weightWithUnit("Bracelet 7gm"), 7);
  assert.equal(weightWithUnit("21k gold"), null);
});

test("metafield weights", () => {
  assert.equal(weightFromMetafield("5.5"), 5.5);
  assert.equal(weightFromMetafield("5.5 g"), 5.5);
  assert.equal(weightFromMetafield('{"value":0.01,"unit":"KILOGRAMS"}'), 10);
  assert.equal(weightFromMetafield(""), null);
});

test("karat normalization", () => {
  for (const v of [
    "21",
    "21k",
    "21K",
    "21 kt",
    "21 karat",
    "عيار 21",
    "21 قيراط",
  ])
    assert.equal(normalizeKarat(v), "21", v);
  assert.equal(normalizeKarat("925"), null);
  assert.equal(karatFromText("GLD-18K-3.2"), "18");
  assert.equal(karatFromText("Size 121k"), null);
  assert.equal(karatFromText("5 kg box"), null);
});

test("origin detection", () => {
  assert.equal(originFromText("محلي"), "local");
  assert.equal(originFromText("Local"), "local");
  assert.equal(originFromText("Imported Italian"), "imported");
  assert.equal(originFromText("Ring"), null);
});

test("karat prices from spot", () => {
  const s = normalizeSettings({});
  const p = karatPrices({ usdPerOunce: 3110.34768, usdEgp: 50 }, s);
  assert.ok(Math.abs(p.gram24 - 5000) < 0.001);
  assert.ok(Math.abs(p.byKarat["21"].price - 4375) < 0.001);
  const withPremium = karatPrices(
    { usdPerOunce: 3110.34768, usdEgp: 50 },
    normalizeSettings({ premiumPct: 2 }),
  );
  assert.ok(Math.abs(withPremium.gram24 - 5100) < 0.001);
  const manual = karatPrices(
    {},
    normalizeSettings({ karatOverrides: { 21: "4000" } }),
  );
  assert.equal(manual.byKarat["21"].price, 4000);
  assert.equal(manual.byKarat["21"].source, "manual");
  assert.equal(manual.byKarat["18"].price, 0);
});

test("piece price and rounding", () => {
  const r = computePiecePrice({
    gramPrice: 4375,
    weight: 5.5,
    makingPerGram: 200,
    discount: 100,
    rounding: "5",
  });
  assert.equal(r.raw, 4375 * 5.5 + 200 * 5.5 - 100);
  assert.equal(r.price % 5, 0);
});

test("detectVariant prefers metafield weight and reads each variant SKU", () => {
  const product = {
    title: "Ring 21k Local",
    productType: "",
    tags: [],
    metafields: [],
  };
  const a = detectVariant(product, {
    title: "Size 7",
    sku: "GLD-21K-LOC-5.5",
    weightGrams: 0,
  });
  assert.deepEqual(
    [a.karat, a.origin, a.weight, a.weightSource],
    ["21", "local", 5.5, "SKU"],
  );
  const withMeta = {
    ...product,
    metafields: [{ key: "metal_weight", value: "4" }],
  };
  assert.equal(
    detectVariant(withMeta, { title: "", sku: "GLD-21K-LOC-5.5" }).weight,
    4,
  );
});

test("buildPlan prices, skips and flags", () => {
  const settings = normalizeSettings({
    making: { 21: { local: 100, imported: 300 } },
    rounding: "1",
    warnChangePct: 20,
  });
  const prices = karatPrices({ usdPerOunce: 3110.34768, usdEgp: 50 }, settings);
  const products = [
    {
      id: "gid://shopify/Product/1",
      title: "Ring 21k Local",
      tags: [],
      metafields: [],
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          title: "",
          sku: "GLD-21K-LOC-5",
          price: "24000",
        },
        {
          id: "gid://shopify/ProductVariant/2",
          title: "",
          sku: "GLD-21K-LOC-2",
          price: "9000",
        },
      ],
    },
    {
      id: "gid://shopify/Product/2",
      title: "Ring 21k",
      tags: [],
      metafields: [],
      variants: [{ id: "v3", title: "", sku: "X-2", price: "1" }],
    },
    {
      id: "gid://shopify/Product/3",
      title: "Silver bowl",
      tags: [],
      metafields: [],
      variants: [{ id: "v4", title: "", sku: "", price: "1" }],
    },
  ];
  const { rows, skipped } = buildPlan(products, settings, prices);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].newPrice, (4375 + 100) * 5);
  assert.equal(rows[0].flagged, false);
  assert.equal(rows[1].flagged, false);
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ["Origin not found", "Karat not found"],
  );

  const assumeLocal = buildPlan(
    products,
    normalizeSettings({ ...settings, unknownOrigin: "local" }),
    prices,
  );
  assert.equal(assumeLocal.rows.length, 3);
  assert.equal(assumeLocal.rows[2].originGuessed, true);
  assert.equal(assumeLocal.rows[2].flagged, true);
});

test("only changes whose Shopify price is unchanged are safe to write", () => {
  const changes = [
    { variantId: "v1", currentPrice: 1000, newPrice: 1100 },
    { variantId: "v2", currentPrice: 2000, newPrice: 2100 },
    { variantId: "v3", currentPrice: 3000, newPrice: 3100 },
  ];
  const current = new Map([
    ["v1", 1000],
    ["v2", 2050],
  ]);
  const { safe, skipped } = splitByCurrentPrice(
    changes,
    current,
    "currentPrice",
  );
  assert.deepEqual(
    safe.map((c) => c.variantId),
    ["v1"],
  );
  assert.deepEqual(
    skipped.map((c) => [c.variantId, c.reason]),
    [
      ["v2", "Price was changed in Shopify since"],
      ["v3", "Variant no longer exists"],
    ],
  );
});
