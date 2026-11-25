// Pure pricing helpers. Shared by the server (plan + apply) and the dashboard (live karat table).
// Keep this file free of server-only imports so it can run in the browser and in unit tests.

export const TROY_OUNCE_GRAMS = 31.1034768;

// ---------------------------------------------------------------------------
// Metals and purities
// ---------------------------------------------------------------------------
//
// Every purity the app can price. To support a new one, add ONE line here:
// detection, settings, dashboard cards and pricing all read from this list.
//   key:      id used in settings and the preview ("21", "S925")
//   metal:    which live spot price it uses ("gold" -> XAU, "silver" -> XAG)
//   fraction: share of the pure-metal price per gram. Like 24K gold, fine silver
//             (999) is priced at the full spot price.
//   codes:    (silver) hallmark numbers recognised in titles, tags, SKUs, metafields
export const METALS = {
  gold: { label: "Gold", symbol: "XAU" },
  silver: { label: "Silver", symbol: "XAG" },
};

export const PURITIES = [
  { key: "24", metal: "gold", label: "24k", fraction: 24 / 24 },
  { key: "22", metal: "gold", label: "22k", fraction: 22 / 24 },
  { key: "21", metal: "gold", label: "21k", fraction: 21 / 24 },
  { key: "18", metal: "gold", label: "18k", fraction: 18 / 24 },
  { key: "14", metal: "gold", label: "14k", fraction: 14 / 24 },
  { key: "10", metal: "gold", label: "10k", fraction: 10 / 24 },
  { key: "9", metal: "gold", label: "9k", fraction: 9 / 24 },
  {
    key: "S999",
    metal: "silver",
    label: "Silver 999",
    fraction: 1,
    codes: ["999"],
  },
  {
    key: "S925",
    metal: "silver",
    label: "Silver 925",
    fraction: 0.925,
    codes: ["925"],
    words: ["sterling"],
  },
];

export const PURITY_KEYS = PURITIES.map((p) => p.key);
export const PURITY_BY_KEY = Object.fromEntries(
  PURITIES.map((p) => [p.key, p]),
);
export const purityLabel = (key) =>
  PURITY_BY_KEY[key]?.label || (key ? `${key}k` : "");

// Gold karats only (kept for detection and older code).
export const KARATS = PURITIES.filter((p) => p.metal === "gold").map(
  (p) => p.key,
);
export const SILVER_KEYS = PURITIES.filter((p) => p.metal === "silver").map(
  (p) => p.key,
);
export const ORIGINS = ["local", "imported"];
export const ORIGIN_LABELS = { local: "Local", imported: "Imported" };

export const DEFAULT_SETTINGS = {
  // Extra % added on top of the global spot price (local market premium). Can be negative.
  premiumPct: 0,
  // Same for silver.
  silverPremiumPct: 0,
  // Optional manual USD -> EGP rate. Empty = use the live rate.
  usdEgpOverride: "",
  // Optional manual price per gram for a purity (EGP). Empty = derive from the live spot price.
  karatOverrides: Object.fromEntries(PURITY_KEYS.map((k) => [k, ""])),
  // Workmanship (making charge) in EGP per gram, by purity and origin.
  making: Object.fromEntries(
    PURITY_KEYS.map((k) => [k, { local: 0, imported: 0 }]),
  ),
  // Flat discount taken off each piece (EGP).
  discountPerPiece: 0,
  // Round the final price to the nearest N EGP. "0.01" = no rounding.
  rounding: "1",
  // Which purities to update.
  includeKarats: [...PURITY_KEYS],
  // What to do with products whose origin can't be detected: "skip" | "local" | "imported".
  unknownOrigin: "skip",
  // Changes larger than this % are flagged in the preview.
  warnChangePct: 20,
};

export function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

/** Merge saved/posted settings over the defaults and coerce types. */
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const making = {};
  const karatOverrides = {};
  for (const k of PURITY_KEYS) {
    const m = (input.making && input.making[k]) || {};
    making[k] = {
      local: Math.max(0, toNumber(m.local, 0)),
      imported: Math.max(0, toNumber(m.imported, 0)),
    };
    const o = input.karatOverrides ? input.karatOverrides[k] : "";
    karatOverrides[k] =
      o === "" || o === null || o === undefined
        ? ""
        : String(Math.max(0, toNumber(o, 0)));
  }
  const includeKarats = Array.isArray(input.includeKarats)
    ? input.includeKarats.map(String).filter((k) => PURITY_KEYS.includes(k))
    : DEFAULT_SETTINGS.includeKarats;
  const usd = input.usdEgpOverride;
  return {
    premiumPct: toNumber(s.premiumPct, 0),
    silverPremiumPct: toNumber(s.silverPremiumPct, 0),
    usdEgpOverride:
      usd === "" || usd === null || usd === undefined
        ? ""
        : String(Math.max(0, toNumber(usd, 0)) || ""),
    karatOverrides,
    making,
    discountPerPiece: Math.max(0, toNumber(s.discountPerPiece, 0)),
    rounding: ["0.01", "1", "5", "10", "50", "100"].includes(String(s.rounding))
      ? String(s.rounding)
      : "1",
    includeKarats,
    unknownOrigin: ["skip", "local", "imported"].includes(s.unknownOrigin)
      ? s.unknownOrigin
      : "skip",
    warnChangePct: Math.max(0, toNumber(s.warnChangePct, 20)),
  };
}

/**
 * Price per gram in EGP for every purity.
 * live: { usdPerOunce, silverUsdPerOunce, usdEgp } from the price service (may be null if offline).
 * Returns { gram24, gramSilver, byKarat: { "21": { price, livePrice, source } }, usdEgp, usdPerOunce, silverUsdPerOunce }.
 * gram24 / gramSilver = price per gram of the pure metal, premium included.
 */
export function karatPrices(live, settings) {
  const usdEgp = settings.usdEgpOverride
    ? toNumber(settings.usdEgpOverride)
    : toNumber(live?.usdEgp, 0);
  const spot = {
    gold: toNumber(live?.usdPerOunce, 0),
    silver: toNumber(live?.silverUsdPerOunce, 0),
  };
  const premium = {
    gold: 1 + toNumber(settings.premiumPct, 0) / 100,
    silver: 1 + toNumber(settings.silverPremiumPct, 0) / 100,
  };
  const pureGram = {};
  for (const metal of Object.keys(METALS)) {
    pureGram[metal] =
      spot[metal] > 0 && usdEgp > 0
        ? (spot[metal] / TROY_OUNCE_GRAMS) * usdEgp * premium[metal]
        : 0;
  }

  const byKarat = {};
  for (const p of PURITIES) {
    const livePrice =
      pureGram[p.metal] > 0 ? pureGram[p.metal] * p.fraction : 0;
    const override = settings.karatOverrides?.[p.key];
    if (override !== "" && override !== undefined && toNumber(override) > 0) {
      byKarat[p.key] = {
        price: toNumber(override),
        livePrice,
        source: "manual",
      };
    } else {
      byKarat[p.key] = { price: livePrice, livePrice, source: "live" };
    }
  }
  return {
    gram24: pureGram.gold,
    gramSilver: pureGram.silver,
    byKarat,
    usdEgp,
    usdPerOunce: spot.gold,
    silverUsdPerOunce: spot.silver,
  };
}

export function roundPrice(price, rounding) {
  const step = toNumber(rounding, 1);
  if (step <= 0.01) return Math.round(price * 100) / 100;
  return Math.round(price / step) * step;
}

/** Final piece price: gold value + workmanship - discount, then rounded. */
export function computePiecePrice({
  gramPrice,
  weight,
  makingPerGram,
  discount,
  rounding,
}) {
  const raw = gramPrice * weight + makingPerGram * weight - (discount || 0);
  return { raw, price: roundPrice(raw, rounding) };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

const KARAT_RE = /(?<!\d)(\d{1,2})\s*(?:k|kt|karat|carat|قيراط)(?![a-z])/i;
const KARAT_PREFIX_RE = /عيار\s*(\d{1,2})(?!\d)/;

/** "21", "21k", "21K", "21 kt", "عيار 21" -> "21". Returns null if not a supported karat. */
export function normalizeKarat(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{1,2}$/.test(text)) return KARATS.includes(text) ? text : null;
  const m = text.match(KARAT_RE) || text.match(KARAT_PREFIX_RE);
  if (m && KARATS.includes(m[1])) return m[1];
  return null;
}

export function karatFromText(text) {
  if (!text) return null;
  const m = String(text).match(KARAT_RE) || String(text).match(KARAT_PREFIX_RE);
  return m && KARATS.includes(m[1]) ? m[1] : null;
}

// Silver: a product is silver when its metal metafield, title, tags, type or SKU says
// so ("silver", "sterling", "فضة") or carries a silver-only hallmark such as 925.
// 999 alone is NOT treated as silver, because fine gold is also stamped 999.
const SILVER_WORDS = ["silver", "sterling", "فضة", "فضه", "فضي"];
const GOLD_WORDS = ["gold", "ذهب"];

function codeRegex(code) {
  return new RegExp(`(?<!\\d)${code}(?![\\d])`);
}

/** "925", "S925", "925 silver", "sterling" -> "S925". null if not a known silver purity. */
export function silverPurityFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const p of PURITIES) {
    if (p.metal !== "silver") continue;
    if ((p.codes || []).some((c) => codeRegex(c).test(t))) return p.key;
  }
  for (const p of PURITIES) {
    if (p.metal !== "silver") continue;
    if ((p.words || []).some((w) => t.includes(w))) return p.key;
  }
  return null;
}

/** Hallmarks that only silver uses (e.g. 925); 999 is shared with gold. */
function hasSilverOnlyHallmark(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const goldFine = ["999"];
  return PURITIES.some(
    (p) =>
      p.metal === "silver" &&
      (p.codes || []).some(
        (c) => !goldFine.includes(c) && codeRegex(c).test(t),
      ),
  );
}

/** "silver" | "gold" | null, from one piece of text. */
export function metalFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (SILVER_WORDS.some((w) => t.includes(w))) return "silver";
  if (GOLD_WORDS.some((w) => t.includes(w))) return "gold";
  return null;
}

const LOCAL_WORDS = ["محلي", "مصري", "local", "egyptian", "egypt"];
const IMPORTED_WORDS = [
  "مستورد",
  "imported",
  "import",
  "italian",
  "ايطالي",
  "إيطالي",
  "turkish",
  "تركي",
];

export function originFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (IMPORTED_WORDS.some((w) => t.includes(w))) return "imported";
  if (LOCAL_WORDS.some((w) => t.includes(w))) return "local";
  return null;
}

// A number followed by an explicit gram unit: "5g", "5.5 gm", "5 grams", "5 جرام", "5 جم".
const GRAM_RE = /(\d+(?:[.,]\d+)?)\s*(?:grams?|gms?|gr|g|جرام|جم)(?![a-z؀-ۿ])/i;

/** Weight in grams only when the text has an explicit unit. Used for titles. */
export function weightWithUnit(text) {
  if (!text) return null;
  const m = String(text).match(GRAM_RE);
  if (!m) return null;
  const n = toNumber(m[1].replace(",", "."), 0);
  return n > 0 ? n : null;
}

/**
 * Weight from a SKU like "GLD-21K-LOC-5.5": explicit unit first, otherwise the LAST
 * number in the SKU, ignoring numbers that are karats (followed by K / KT).
 */
export function weightFromSku(sku) {
  if (!sku) return null;
  const withUnit = weightWithUnit(sku);
  if (withUnit) return withUnit;
  const parts = String(sku)
    .split(/[^0-9a-z.,]+/i)
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^\d+(?:[.,]\d+)?$/.test(part)) {
      const n = toNumber(part.replace(",", "."), 0);
      if (n > 0 && n < 1000) return n;
      return null;
    }
  }
  return null;
}

/** Metafield value -> grams. Accepts "5.5", "5.5g" or Shopify weight JSON {"value":5.5,"unit":"GRAMS"}. */
export function weightFromMetafield(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      return toGrams(toNumber(obj.value, 0), obj.unit);
    } catch {
      return null;
    }
  }
  const n = toNumber(text.replace(/[^\d.,]/g, "").replace(",", "."), 0);
  return n > 0 ? n : null;
}

export function toGrams(value, unit) {
  const v = toNumber(value, 0);
  if (!(v > 0)) return null;
  switch (String(unit || "GRAMS").toUpperCase()) {
    case "KILOGRAMS":
    case "KG":
      return v * 1000;
    case "POUNDS":
    case "LB":
      return v * 453.59237;
    case "OUNCES":
    case "OZ":
      return v * 28.349523125;
    default:
      return v;
  }
}

const KARAT_KEYS = ["karat", "carat", "purity", "fineness", "عيار"];
const METAL_KEYS = ["metal", "material", "metal_type", "المعدن"];
const ORIGIN_KEYS = ["origin", "المنشأ"];
const WEIGHT_KEYS = [
  "metal_weight",
  "metalweight",
  "gold_weight",
  "goldweight",
  "weight_grams",
  "weight_g",
];
const MAKING_KEYS = ["making_charge", "makingcharge", "workmanship", "مصنعية"];

function findMeta(metafields, keys) {
  const hit = (metafields || []).find((m) =>
    keys.includes(String(m.key).toLowerCase()),
  );
  return hit ? hit.value : null;
}

/**
 * Work out karat, origin, weight and making-charge override for one variant.
 * product: { title, productType, tags[], metafields[{key,value}] }
 * variant: { title, sku, weightGrams }
 */
export function detectVariant(product, variant) {
  const metafields = product.metafields || [];
  const tags = product.tags || [];

  const texts = [
    product.title,
    ...tags,
    product.productType,
    variant.title,
    variant.sku,
  ];
  const metaMetal = metalFromText(findMeta(metafields, METAL_KEYS));
  const metaPurity = findMeta(metafields, KARAT_KEYS);
  const metal =
    metaMetal ||
    (silverPurityFromText(metaPurity) && !normalizeKarat(metaPurity)
      ? "silver"
      : null) ||
    texts.map(metalFromText).find(Boolean) ||
    (texts.some(hasSilverOnlyHallmark) ? "silver" : "gold");

  let karat = null;
  let karatSource = null;
  const tries =
    metal === "silver"
      ? [
          ["metafield", silverPurityFromText(metaPurity)],
          ["title", silverPurityFromText(product.title)],
          ["tags", tags.map(silverPurityFromText).find(Boolean) || null],
          ["product type", silverPurityFromText(product.productType)],
          ["variant title", silverPurityFromText(variant.title)],
          ["SKU", silverPurityFromText(variant.sku)],
        ]
      : [
          ["metafield", normalizeKarat(metaPurity)],
          ["title", karatFromText(product.title)],
          ["tags", tags.map(karatFromText).find(Boolean) || null],
          ["product type", karatFromText(product.productType)],
          ["SKU", karatFromText(variant.sku)],
        ];
  for (const [src, val] of tries) {
    if (val) {
      karat = val;
      karatSource = src;
      break;
    }
  }

  let origin = null;
  const originTries = [
    originFromText(findMeta(metafields, ORIGIN_KEYS)),
    originFromText(product.title),
    tags.map(originFromText).find(Boolean) || null,
    originFromText(product.productType),
  ];
  origin = originTries.find(Boolean) || null;

  let weight = null;
  let weightSource = null;
  const weightTries = [
    ["metafield", weightFromMetafield(findMeta(metafields, WEIGHT_KEYS))],
    ["variant title", weightWithUnit(variant.title)],
    ["SKU", weightFromSku(variant.sku)],
    ["product title", weightWithUnit(product.title)],
    ["tags", tags.map(weightWithUnit).find(Boolean) || null],
    ["shipping weight", variant.weightGrams > 0 ? variant.weightGrams : null],
  ];
  for (const [src, val] of weightTries) {
    if (val) {
      weight = Math.round(val * 1000) / 1000;
      weightSource = src;
      break;
    }
  }

  const makingRaw = findMeta(metafields, MAKING_KEYS);
  const makingOverride =
    makingRaw !== null && toNumber(makingRaw, -1) >= 0
      ? toNumber(makingRaw)
      : null;

  return {
    metal,
    karat,
    karatSource,
    origin,
    weight,
    weightSource,
    makingOverride,
  };
}

/**
 * Build the price plan for a list of products.
 * Returns { rows, skipped } where each row is one variant whose price would be set.
 */
export function buildPlan(products, settings, prices) {
  const rows = [];
  const skipped = [];

  for (const product of products) {
    for (const variant of product.variants) {
      const d = detectVariant(product, variant);
      const base = {
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku || "",
        currentPrice: toNumber(variant.price, 0),
        metal: d.metal,
        karat: d.karat,
        origin: d.origin,
        weight: d.weight,
        weightSource: d.weightSource,
      };

      if (!d.karat) {
        skipped.push({
          ...base,
          reason:
            d.metal === "silver"
              ? "Silver purity not found"
              : "Karat not found",
        });
        continue;
      }
      if (!settings.includeKarats.includes(d.karat)) continue;

      let origin = d.origin;
      let originGuessed = false;
      if (!origin) {
        if (settings.unknownOrigin === "skip") {
          skipped.push({ ...base, reason: "Origin not found" });
          continue;
        }
        origin = settings.unknownOrigin;
        originGuessed = true;
      }
      if (!d.weight) {
        skipped.push({ ...base, origin, reason: "Weight not found" });
        continue;
      }

      const gram = prices.byKarat[d.karat]?.price || 0;
      if (!(gram > 0)) {
        skipped.push({
          ...base,
          origin,
          reason: `No ${d.metal} price for ${purityLabel(d.karat)}`,
        });
        continue;
      }

      const makingPerGram =
        d.makingOverride ?? settings.making[d.karat]?.[origin] ?? 0;
      const { price } = computePiecePrice({
        gramPrice: gram,
        weight: d.weight,
        makingPerGram,
        discount: settings.discountPerPiece,
        rounding: settings.rounding,
      });

      if (!(price > 0)) {
        skipped.push({
          ...base,
          origin,
          reason: "Calculated price is zero or negative",
        });
        continue;
      }

      const changePct =
        base.currentPrice > 0
          ? ((price - base.currentPrice) / base.currentPrice) * 100
          : null;
      const unchanged = Math.abs(price - base.currentPrice) < 0.005;
      rows.push({
        ...base,
        origin,
        originGuessed,
        gramPrice: gram,
        makingPerGram,
        makingFromProduct: d.makingOverride !== null,
        newPrice: Math.round(price * 100) / 100,
        changePct,
        unchanged,
        flagged:
          changePct !== null && Math.abs(changePct) > settings.warnChangePct,
      });
    }
  }

  return { rows, skipped };
}

/**
 * Split changes into ones that are safe to write and ones whose price in Shopify is no
 * longer what we expect (someone edited it by hand, or the variant was deleted).
 * expectedKey: the field holding the price we expect to find in Shopify right now.
 */
export function splitByCurrentPrice(changes, currentPrices, expectedKey) {
  const safe = [];
  const skipped = [];
  for (const c of changes) {
    const current = currentPrices.get(c.variantId);
    if (current === undefined) {
      skipped.push({ ...c, reason: "Variant no longer exists" });
    } else if (Math.abs(current - Number(c[expectedKey])) >= 0.005) {
      skipped.push({
        ...c,
        actualPrice: current,
        reason: "Price was changed in Shopify since",
      });
    } else {
      safe.push(c);
    }
  }
  return { safe, skipped };
}
