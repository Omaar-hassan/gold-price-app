// Shopify Admin API + database helpers for the gold price dashboard.
import db from "../db.server";
import { normalizeSettings } from "./pricing";

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
        featuredImage { url(transform: { maxWidth: 80, maxHeight: 80 }) }
        metafields(first: 15) { nodes { namespace key value } }
        variants(first: 25) {
          pageInfo { hasNextPage }
          nodes {
            id
            title
            price
            sku
            inventoryItem { measurement { weight { unit value } } }
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
        image: p.featuredImage?.url || null,
        metafields: p.metafields.nodes.map((m) => ({
          namespace: m.namespace,
          key: m.key,
          value: m.value,
        })),
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

// ---------------------------------------------------------------------------
// Settings + history
// ---------------------------------------------------------------------------

export async function loadSettings(shop) {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  if (!row) return normalizeSettings({});
  try {
    return normalizeSettings(JSON.parse(row.data));
  } catch {
    return normalizeSettings({});
  }
}

export async function saveSettings(shop, settings) {
  const clean = normalizeSettings(settings);
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, data: JSON.stringify(clean) },
    update: { data: JSON.stringify(clean) },
  });
  return clean;
}

export async function recordRun(shop, run) {
  return db.priceRun.create({
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
}

export async function recentRuns(shop, take = 8) {
  const rows = await db.priceRun.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
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
  return db.priceRun.findFirst({ where: { shop, id } });
}

export async function markUndone(id) {
  return db.priceRun.update({ where: { id }, data: { undone: true } });
}
