// Shopify Admin API + database helpers for the gold price dashboard.
import db from "../db.server";
import { normalizeSettings } from "./pricing";

export { splitByCurrentPrice } from "./pricing";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isThrottled(error) {
  const text = JSON.stringify(
    error?.body || error?.response || error?.message || "",
  );
  return /THROTTLED|Throttled|429/.test(text);
}

/** admin.graphql with retry + backoff on rate limits. Returns the parsed `data`. */
export async function gql(admin, query, variables, attempt = 0) {
  try {
    const res = await admin.graphql(query, { variables });
    const body = await res.json();
    if (body.errors) {
      const err = new Error(JSON.stringify(body.errors));
      err.body = body.errors;
      throw err;
    }
    return body.data;
  } catch (error) {
    if (isThrottled(error) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      return gql(admin, query, variables, attempt + 1);
    }
    throw error;
  }
}

// Page size is kept small so the query stays under Shopify's 1,000 point cost limit
// (10 products x (15 metafields + 25 variants x 2) ≈ 660 points).
const PRODUCTS_QUERY = `#graphql
  query GoldProducts($cursor: String) {
    products(first: 10, after: $cursor, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        productType
        tags
        featuredMedia { preview { image { url(transform: { maxWidth: 80, maxHeight: 80 }) } } }
        metafields(first: 15) { nodes { namespace key value } }
        fixMetal: metafield(namespace: "gold_price", key: "metal") { value }
        fixKarat: metafield(namespace: "gold_price", key: "karat") { value }
        fixOrigin: metafield(namespace: "gold_price", key: "origin") { value }
        variants(first: 25) {
          pageInfo { hasNextPage }
          nodes {
            id
            title
            price
            sku
            inventoryItem { measurement { weight { unit value } } }
            fixWeight: metafield(namespace: "gold_price", key: "metal_weight") { value }
          }
        }
      }
    }
  }
`;

const EXTRA_VARIANTS_QUERY = `#graphql
  query MoreVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          price
          sku
          inventoryItem { measurement { weight { unit value } } }
          fixWeight: metafield(namespace: "gold_price", key: "metal_weight") { value }
        }
      }
    }
  }
`;

function mapVariant(v) {
  const w = v.inventoryItem?.measurement?.weight;
  let grams = 0;
  if (w && w.value > 0) {
    const unit = String(w.unit || "GRAMS").toUpperCase();
    grams =
      unit === "KILOGRAMS"
        ? w.value * 1000
        : unit === "POUNDS"
          ? w.value * 453.59237
          : unit === "OUNCES"
            ? w.value * 28.349523125
            : w.value;
  }
  return {
    id: v.id,
    title: v.title === "Default Title" ? "" : v.title,
    price: v.price,
    sku: v.sku,
    weightGrams: grams,
    // Weight set with the Fix form (variant metafield gold_price.metal_weight).
    fixWeight: v.fixWeight?.value ?? null,
  };
}

/** Load every product in the store (all pages, all variants). */
export async function fetchAllProducts(admin) {
  const products = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const data = await gql(admin, PRODUCTS_QUERY, { cursor });
    const conn = data.products;
    for (const p of conn.nodes) {
      const variants = p.variants.nodes.map(mapVariant);
      if (p.variants.pageInfo.hasNextPage) {
        // Rare for jewelry, but load the rest so no variant is silently skipped.
        let vCursor = null;
        variants.length = 0;
        for (;;) {
          const more = await gql(admin, EXTRA_VARIANTS_QUERY, {
            id: p.id,
            cursor: vCursor,
          });
          variants.push(...more.product.variants.nodes.map(mapVariant));
          if (!more.product.variants.pageInfo.hasNextPage) break;
          vCursor = more.product.variants.pageInfo.endCursor;
        }
      }
      products.push({
        id: p.id,
        title: p.title,
        status: p.status,
        productType: p.productType,
        tags: p.tags || [],
        image: p.featuredMedia?.preview?.image?.url || null,
        metafields: [
          ...p.metafields.nodes.map((m) => ({
            namespace: m.namespace,
            key: m.key,
            value: m.value,
          })),
          // Values set with the Fix form, read explicitly so they are never cut
          // off by the 15-metafield limit above.
          ...[
            ["metal", p.fixMetal],
            ["karat", p.fixKarat],
            ["origin", p.fixOrigin],
          ]
            .filter(([, m]) => m?.value)
            .map(([key, m]) => ({
              namespace: "gold_price",
              key,
              value: m.value,
            })),
        ],
        variants,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return products;
}

const BULK_UPDATE = `#graphql
  mutation SetPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

/**
 * Set prices. changes: [{ productId, variantId, newPrice, productTitle }]
 * Sends one mutation per product (all its variants together).
 */
export async function applyPrices(admin, changes) {
  const byProduct = new Map();
  for (const c of changes) {
    if (!byProduct.has(c.productId)) byProduct.set(c.productId, []);
    byProduct.get(c.productId).push(c);
  }

  const updated = [];
  const errors = [];
  for (const [productId, items] of byProduct) {
    try {
      const data = await gql(admin, BULK_UPDATE, {
        productId,
        variants: items.map((i) => ({
          id: i.variantId,
          price: Number(i.newPrice).toFixed(2),
        })),
      });
      const result = data.productVariantsBulkUpdate;
      if (result.userErrors?.length) {
        errors.push({
          productId,
          productTitle: items[0].productTitle,
          message: result.userErrors.map((e) => e.message).join(", "),
        });
      } else {
        updated.push(...items);
      }
    } catch (error) {
      errors.push({
        productId,
        productTitle: items[0].productTitle,
        message: error.message,
      });
    }
  }
  return { updated, errors };
}

const VARIANT_PRICES_QUERY = `#graphql
  query VariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id price }
    }
  }
`;

/** Current price of each variant, straight from Shopify. Returns Map(variantId -> number). */
export async function fetchVariantPrices(admin, variantIds) {
  const prices = new Map();
  const ids = [...new Set(variantIds)];
  for (let i = 0; i < ids.length; i += 250) {
    const data = await gql(admin, VARIANT_PRICES_QUERY, {
      ids: ids.slice(i, i + 250),
    });
    for (const node of data.nodes || []) {
      if (node?.id) prices.set(node.id, Number(node.price));
    }
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export const PREVIEW_MAX_AGE_MS = 60 * 60 * 1000;

export async function savePreview(shop, snapshot, rows) {
  try {
    // Old previews are only needed for a short while.
    await db.pricePreview.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
  } catch (error) {
    console.error("[gold-price] could not clean old previews:", error.message);
  }
  const preview = await db.pricePreview.create({
    data: {
      shop,
      gram24: snapshot.gram24 || null,
      usdPerOunce: snapshot.usdPerOunce || null,
      usdEgp: snapshot.usdEgp || null,
      rows: JSON.stringify(
        rows.map((r) => ({
          productId: r.productId,
          variantId: r.variantId,
          productTitle: r.productTitle,
          variantTitle: r.variantTitle || "",
          currentPrice: r.currentPrice,
          newPrice: r.newPrice,
        })),
      ),
    },
  });
  return preview.id;
}

/**
 * Claim a preview for applying. Returns { preview } or { error }.
 * The claim is atomic, so a double click or a second tab can't apply it twice.
 */
export async function claimPreview(shop, id) {
  const preview = await db.pricePreview.findFirst({ where: { shop, id } });
  if (!preview)
    return { error: "This preview was not found. Run Preview again." };
  if (preview.appliedAt) return { error: "These prices were already applied." };
  if (Date.now() - preview.createdAt.getTime() > PREVIEW_MAX_AGE_MS)
    return {
      error:
        "This preview is more than an hour old. Run Preview again to use the latest gold price.",
    };
  const claimed = await db.pricePreview.updateMany({
    where: { id, shop, appliedAt: null },
    data: { appliedAt: new Date() },
  });
  if (claimed.count !== 1)
    return { error: "These prices were already applied." };
  return { preview: { ...preview, rows: JSON.parse(preview.rows) } };
}

// ---------------------------------------------------------------------------
// Settings + history
// ---------------------------------------------------------------------------

// Settings are stored in an app-owned shop metafield, so they survive even when the
// server's disk is wiped (Render's free plan resets the SQLite file on every restart).
// The database copy is only a backup. Nothing here throws: the dashboard always loads.
const SETTINGS_QUERY = `#graphql
  query GoldSettings {
    shop {
      id
      metafield(namespace: "$app", key: "settings") { value }
    }
  }
`;

const SETTINGS_SAVE = `#graphql
  mutation SaveGoldSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

function parseSettings(text) {
  try {
    // Settings saved before multi-currency have no currency: they were all EGP.
    return normalizeSettings({ currency: "EGP", ...JSON.parse(text) });
  } catch {
    return null;
  }
}

const SHOP_INFO_TTL_MS = 5 * 60 * 1000;
const shopInfoCache = new Map(); // shop -> { info, at }

/**
 * The store facts pricing depends on, read from Shopify (cached 5 minutes per shop):
 * - currency: the store currency (shop.currencyCode), which product prices are saved
 *   in. All prices the app writes are in this currency. null = could not be read.
 * - taxesIncluded: Shopify's "Include tax in product prices" setting.
 *   true  = prices include tax, so the app may add VAT to the price.
 *   false = Shopify adds tax at checkout, so the app must not add VAT (double VAT).
 *   null  = could not be read.
 * - timeZone: the store's time zone (IANA name), for showing dates.
 */
export async function fetchShopInfo(admin, shop) {
  const hit = shopInfoCache.get(shop);
  if (hit && Date.now() - hit.at < SHOP_INFO_TTL_MS) return hit.info;
  try {
    const data = await gql(
      admin,
      `#graphql
      query ShopInfo { shop { currencyCode taxesIncluded ianaTimezone } }
    `,
    );
    const info = {
      currency: /^[A-Z]{3}$/.test(data?.shop?.currencyCode || "")
        ? data.shop.currencyCode
        : null,
      taxesIncluded:
        typeof data?.shop?.taxesIncluded === "boolean"
          ? data.shop.taxesIncluded
          : null,
      timeZone: data?.shop?.ianaTimezone || null,
    };
    if (info.currency) shopInfoCache.set(shop, { info, at: Date.now() });
    return info;
  } catch (error) {
    console.error("[gold-price] could not read shop info:", error.message);
    return { currency: null, taxesIncluded: null, timeZone: null };
  }
}

export async function loadSettings(admin, shop) {
  try {
    const data = await gql(admin, SETTINGS_QUERY);
    const fromShop = data?.shop?.metafield?.value
      ? parseSettings(data.shop.metafield.value)
      : null;
    if (fromShop) return fromShop;
  } catch (error) {
    console.error(
      "[gold-price] could not read settings metafield:",
      error.message,
    );
  }
  try {
    const row = await db.shopSettings.findUnique({ where: { shop } });
    const fromDb = row ? parseSettings(row.data) : null;
    if (fromDb) return fromDb;
  } catch (error) {
    console.error(
      "[gold-price] could not read settings from database:",
      error.message,
    );
  }
  return normalizeSettings({});
}

// currency: the store currency the amounts are in (from fetchShopInfo, never from
// the browser; falls back to the currency already on the settings only when Shopify
// could not be read). It is stamped on the saved settings.
export async function saveSettings(admin, shop, settings, currency) {
  const clean = normalizeSettings({
    ...settings,
    currency: currency || settings?.currency || "",
  });
  const value = JSON.stringify(clean);
  let saved = false;
  let lastError = null;

  try {
    const { shop: shopInfo } = await gql(admin, SETTINGS_QUERY);
    const result = await gql(admin, SETTINGS_SAVE, {
      metafields: [
        {
          ownerId: shopInfo.id,
          namespace: "$app",
          key: "settings",
          type: "json",
          value,
        },
      ],
    });
    const errors = result.metafieldsSet.userErrors;
    if (errors?.length)
      throw new Error(errors.map((e) => e.message).join(", "));
    saved = true;
  } catch (error) {
    lastError = error;
    console.error(
      "[gold-price] could not save settings metafield:",
      error.message,
    );
  }

  try {
    await db.shopSettings.upsert({
      where: { shop },
      create: { shop, data: value },
      update: { data: value },
    });
    saved = true;
  } catch (error) {
    lastError = lastError || error;
    console.error(
      "[gold-price] could not save settings to database:",
      error.message,
    );
  }

  if (!saved)
    throw new Error(
      `Settings could not be saved (${lastError?.message || "unknown error"})`,
    );
  return clean;
}

export async function recordRun(shop, run) {
  try {
    return await db.priceRun.create({
      data: {
        shop,
        kind: run.kind || "apply",
        gram24: run.gram24 ?? null,
        usdPerOunce: run.usdPerOunce ?? null,
        usdEgp: run.usdEgp ?? null,
        updatedCount: run.updated.length,
        failedCount: run.errors.length,
        changes: JSON.stringify(
          run.updated.map((u) => ({
            productId: u.productId,
            variantId: u.variantId,
            productTitle: u.productTitle,
            variantTitle: u.variantTitle || "",
            oldPrice: u.currentPrice,
            newPrice: u.newPrice,
          })),
        ),
        errors: run.errors.length ? JSON.stringify(run.errors) : null,
      },
    });
  } catch (error) {
    // Prices were already updated in Shopify; a missing history row must not turn that into an error.
    console.error("[gold-price] could not record price run:", error.message);
    return null;
  }
}

export async function recentRuns(shop, take = 8) {
  let rows = [];
  try {
    rows = await db.priceRun.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take,
    });
  } catch (error) {
    console.error("[gold-price] could not load price history:", error.message);
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt.toISOString(),
    gram24: r.gram24,
    updatedCount: r.updatedCount,
    failedCount: r.failedCount,
    undone: r.undone,
  }));
}

export async function getRun(shop, id) {
  try {
    return await db.priceRun.findFirst({ where: { shop, id } });
  } catch (error) {
    console.error("[gold-price] could not load price run:", error.message);
    return null;
  }
}

export async function markUndone(id) {
  try {
    return await db.priceRun.update({ where: { id }, data: { undone: true } });
  } catch (error) {
    console.error("[gold-price] could not mark run as undone:", error.message);
    return null;
  }
}

const FIX_SAVE = `#graphql
  mutation SaveProductFix($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

/**
 * Save what the merchant entered in the Products screen's Fix form as metafields
 * (namespace gold_price). Metal, purity and origin go on the product (all its
 * variants); weight goes on the one variant. Never touches prices. Only the given
 * fields are written; values must already be validated.
 * fix: { metal?: "gold" | "silver", karat?: "21K" | "S925" ..., origin?: "local" | "imported", weight?: grams }
 */
export async function saveProductFix(admin, productId, variantId, fix) {
  const metafields = [];
  const add = (key, type, value, ownerId = productId) =>
    metafields.push({
      ownerId,
      namespace: "gold_price",
      key,
      type,
      value: String(value),
    });
  if (fix.metal) add("metal", "single_line_text_field", fix.metal);
  if (fix.karat) add("karat", "single_line_text_field", fix.karat);
  if (fix.origin) add("origin", "single_line_text_field", fix.origin);
  if (fix.weight) add("metal_weight", "number_decimal", fix.weight, variantId);
  if (!metafields.length) return;
  const result = await gql(admin, FIX_SAVE, { metafields });
  const errors = result.metafieldsSet.userErrors;
  if (errors?.length) throw new Error(errors.map((e) => e.message).join(", "));
}
