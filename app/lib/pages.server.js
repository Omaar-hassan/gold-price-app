// Server code shared by the app's pages (Dashboard, Metal Rates, Pricing, Price
// Updates, History, Settings): the common loader data and the actions
// save / preview / apply / undo. Each page's route re-exports `pageAction`.
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice } from "./goldPrice.server";
import {
  applyPrices,
  claimPreview,
  fetchAllProducts,
  fetchShopInfo,
  fetchVariantPrices,
  getRun,
  loadSettings,
  markUndone,
  recentRuns,
  recordRun,
  savePreview,
  saveSettings,
  splitByCurrentPrice,
} from "./store.server";
import { buildPlan, karatPrices, toNumber } from "./pricing";

/**
 * What every page needs: the shop facts, saved settings and the live price in the
 * store currency. If Shopify can't be read, the last saved currency is shown (price
 * updates stay blocked until it can).
 */
export async function loadContext(request) {
  const { admin, session } = await authenticate.admin(request);
  const [shopInfo, settings] = await Promise.all([
    fetchShopInfo(admin, session.shop),
    loadSettings(admin, session.shop),
  ]);
  const currency = shopInfo.currency || settings.currency || "USD";
  const live = await getLiveGoldPrice(currency);
  return {
    admin,
    shopDomain: session.shop,
    shopInfo,
    settings,
    live,
    currency,
    // Sent to the browser.
    common: {
      live,
      settings,
      taxesIncluded: shopInfo.taxesIncluded,
      shop: {
        currency,
        currencyKnown: Boolean(shopInfo.currency),
        timeZone: shopInfo.timeZone || "UTC",
      },
    },
  };
}

// Why a preview can't run, or null. Each reason is a clear message instead of
// pricing with a wrong currency or an old exchange rate.
async function currencyProblem(admin, shop, shopInfo) {
  if (!shopInfo.currency)
    return "We couldn't read your store currency from Shopify, so no prices were calculated. Please try again in a minute.";
  const stored = await loadSettings(admin, shop);
  if (stored.currency && stored.currency !== shopInfo.currency)
    return `Your saved amounts (making charges, fees, manual prices) are in ${stored.currency}, but your store currency is now ${shopInfo.currency}. Check them, then press Save on any settings page to confirm they are in ${shopInfo.currency}.`;
  return null;
}

function rateProblem(currency, settings, live) {
  if (settings.usdEgpOverride || !live.fx.outdated) return null;
  // Only matters if some purity being updated uses the live price (no manual price).
  const usesLive = settings.includeKarats.some(
    (k) => !(Number(settings.karatOverrides?.[k]) > 0),
  );
  if (!usesLive) return null;
  return live.usdRate
    ? `The USD → ${currency} exchange rate is out of date (last updated ${live.fx.updatedAt ? new Date(live.fx.updatedAt).toUTCString() : "unknown"}), so no prices were calculated. Try again later, or enter a manual exchange rate on the Metal Rates page.`
    : `The USD → ${currency} exchange rate is unavailable (${live.fx.error || "unknown error"}), so no prices were calculated. Try again later, or enter a manual exchange rate on the Metal Rates page.`;
}

/**
 * The action every page posts to (JSON body with `intent`):
 * - save:    { settings: patch } merged onto the saved settings (each page sends
 *            only the fields it edits, so pages never overwrite each other).
 * - preview: optional { settings: patch } saved first, then the price plan.
 * - apply:   { previewId, variantIds } from a saved preview (never browser prices).
 * - undo:    { runId } restores a run, skipping prices edited by hand since.
 */
export async function pageAction({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, { status: 400 });
  }

  const savePatch = async (shopInfo) => {
    const stored = await loadSettings(admin, shop);
    return saveSettings(
      admin,
      shop,
      { ...stored, ...(body.settings || {}) },
      shopInfo.currency,
    );
  };

  try {
    if (body.intent === "save") {
      const shopInfo = await fetchShopInfo(admin, shop);
      const settings = await savePatch(shopInfo);
      return json({ intent: "save", ok: true, settings });
    }

    if (body.intent === "preview") {
      const shopInfo = await fetchShopInfo(admin, shop);
      const blocked = await currencyProblem(admin, shop, shopInfo);
      if (blocked)
        return json({ intent: "preview", error: blocked }, { status: 409 });
      const settings = body.settings
        ? await savePatch(shopInfo)
        : await loadSettings(admin, shop);
      const live = await getLiveGoldPrice(shopInfo.currency);
      const rateBlocked = rateProblem(shopInfo.currency, settings, live);
      if (rateBlocked)
        return json({ intent: "preview", error: rateBlocked }, { status: 503 });
      const prices = karatPrices(live, settings);
      const anyPrice = Object.values(prices.byKarat).some((p) => p.price > 0);
      if (!anyPrice) {
        return json(
          {
            intent: "preview",
            error:
              "The live gold price is unavailable right now. Try again in a minute, or enter manual prices per gram on the Metal Rates page.",
          },
          { status: 503 },
        );
      }
      const products = await fetchAllProducts(admin);
      const { taxesIncluded } = shopInfo;
      const images = Object.fromEntries(products.map((p) => [p.id, p.image]));
      const plan = buildPlan(products, settings, prices, { taxesIncluded });
      if (plan.formulaError) {
        return json(
          { intent: "preview", error: plan.formulaError },
          { status: 400 },
        );
      }
      const snapshot = {
        gram24: prices.gram24,
        usdPerOunce: prices.usdPerOunce,
        usdEgp: prices.usdRate,
        currency: shopInfo.currency,
        byKarat: prices.byKarat,
        at: new Date().toISOString(),
      };
      const previewId = await savePreview(shop, snapshot, plan.rows);
      return json({
        intent: "preview",
        ok: true,
        previewId,
        productCount: products.length,
        rows: plan.rows.map((r) => ({
          ...r,
          image: images[r.productId] || null,
        })),
        skipped: plan.skipped,
        vatBlocked: plan.vatBlocked,
        warnChangePct: settings.warnChangePct,
        snapshot,
      });
    }

    if (body.intent === "apply") {
      // Prices come from the preview saved on the server, never from the browser.
      const wanted = new Set((body.variantIds || []).map(String));
      if (!wanted.size)
        return json(
          { intent: "apply", error: "Nothing selected to update." },
          { status: 400 },
        );
      const claim = await claimPreview(shop, String(body.previewId || ""));
      if (claim.error)
        return json({ intent: "apply", error: claim.error }, { status: 409 });
      const { preview } = claim;
      const changes = preview.rows.filter(
        (r) => wanted.has(r.variantId) && toNumber(r.newPrice, 0) > 0,
      );
      // Skip variants whose price was edited in Shopify after the preview.
      const current = await fetchVariantPrices(
        admin,
        changes.map((c) => c.variantId),
      );
      const { safe, skipped } = splitByCurrentPrice(
        changes,
        current,
        "currentPrice",
      );

      const result = safe.length
        ? await applyPrices(admin, safe)
        : { updated: [], errors: [] };
      if (result.updated.length || result.errors.length) {
        await recordRun(shop, {
          kind: "apply",
          gram24: preview.gram24,
          usdPerOunce: preview.usdPerOunce,
          usdEgp: preview.usdEgp,
          ...result,
        });
      }
      return json({
        intent: "apply",
        ok: true,
        updatedCount: result.updated.length,
        errors: result.errors,
        skipped,
        runs: await recentRuns(shop, 50),
      });
    }

    if (body.intent === "undo") {
      const run = await getRun(shop, Number(body.runId));
      if (!run || run.undone || run.kind !== "apply") {
        return json(
          { intent: "undo", error: "This run can't be undone." },
          { status: 400 },
        );
      }
      const original = JSON.parse(run.changes || "[]");
      const changes = original
        .filter((c) => toNumber(c.oldPrice, 0) > 0)
        .map((c) => ({ ...c, currentPrice: c.newPrice, newPrice: c.oldPrice }));
      // Only restore prices that are still what this run set. A price edited by hand
      // afterwards is left alone and reported.
      const current = await fetchVariantPrices(
        admin,
        changes.map((c) => c.variantId),
      );
      const { safe, skipped } = splitByCurrentPrice(
        changes,
        current,
        "currentPrice",
      );
      const result = safe.length
        ? await applyPrices(admin, safe)
        : { updated: [], errors: [] };
      if (result.updated.length || result.errors.length)
        await recordRun(shop, { kind: "undo", ...result });
      if (!result.errors.length) await markUndone(run.id);
      return json({
        intent: "undo",
        ok: true,
        updatedCount: result.updated.length,
        errors: result.errors,
        skipped,
        runs: await recentRuns(shop, 50),
      });
    }

    return json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[gold-price] action failed:", error);
    return json(
      { intent: body.intent, error: "Something went wrong: " + error.message },
      { status: 500 },
    );
  }
}
