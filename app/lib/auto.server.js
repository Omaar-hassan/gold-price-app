// Automatic price updates. An outside timer calls /api/auto-run every few minutes
// (Render's free plan sleeps, so the app can't keep its own clock). Each call looks
// for stores whose scheduled time is due and updates their prices, like pressing
// Preview then Apply, with these safety rules:
// - Only stores that switched automatic updates on in Settings.
// - Each scheduled time runs once per store (unique AutoRun row).
// - No live price, an outdated one, or a currency problem: the run is skipped.
// - Changes over the store's warning % are held for the merchant, never applied.
// - Every run is in History and can be undone like a manual one.
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getLiveGoldPrice, rateJumps } from "./goldPrice.server";
import { currencyProblem, rateProblem } from "./pages.server";
import { buildPlan, karatPrices, PURITY_BY_KEY, toNumber } from "./pricing";
import { dueSlot, nextSlot } from "./schedule";
import {
  applyPrices,
  fetchAllProducts,
  fetchShopInfo,
  loadSettings,
  logActivity,
  recordRun,
} from "./store.server";

let running = false;

// Stores whose saved settings have automatic updates on (the database keeps a copy
// of every save, so this needs no Shopify call).
async function enabledShops() {
  const rows = await db.shopSettings.findMany({
    select: { shop: true, data: true },
  });
  return rows
    .filter((r) => {
      try {
        return JSON.parse(r.data)?.auto?.enabled === true;
      } catch {
        return false;
      }
    })
    .map((r) => r.shop);
}

// Why the live price can't be trusted for these changes, or null. A purity with a
// manual price per gram doesn't need the live price.
function livePriceProblem(rows, settings, live) {
  for (const r of rows) {
    if (Number(settings.karatOverrides?.[r.karat]) > 0) continue;
    const metal = PURITY_BY_KEY[r.karat]?.metal || r.metal || "gold";
    const feed = live[metal];
    if (!feed || feed.stale || feed.error)
      return `The live ${metal} price was unavailable or out of date, so no prices were changed.`;
  }
  return null;
}

/**
 * Update one store for one scheduled time. Returns the AutoRun row's final fields.
 * The plan is worked out from the prices in Shopify right now, so a price edited by
 * hand is simply the new starting point.
 */
export async function runShop(shop, admin, settings, shopInfo) {
  const blocked = await currencyProblem(admin, shop, shopInfo);
  if (blocked) return { status: "skipped", message: blocked };
  const live = await getLiveGoldPrice(shopInfo.currency);
  const rateBlocked = rateProblem(shopInfo.currency, settings, live);
  if (rateBlocked) return { status: "skipped", message: rateBlocked };

  const prices = karatPrices(live, settings);
  const products = await fetchAllProducts(admin);
  const plan = buildPlan(products, settings, prices, {
    taxesIncluded: shopInfo.taxesIncluded,
  });
  if (plan.formulaError)
    return { status: "skipped", message: plan.formulaError };

  const changes = plan.rows.filter(
    (r) => !r.unchanged && toNumber(r.newPrice, 0) > 0,
  );
  const stale = livePriceProblem(changes, settings, live);
  if (stale) return { status: "skipped", message: stale };

  // A sudden jump in the metal price may be a bad price feed: change nothing and
  // let the merchant check it. Purities with a manual price don't use the feed.
  const liveMetals = [
    ...new Set(
      changes
        .filter((r) => !(Number(settings.karatOverrides?.[r.karat]) > 0))
        .map((r) => PURITY_BY_KEY[r.karat]?.metal || r.metal || "gold"),
    ),
  ];
  const jumps = await rateJumps(live, liveMetals, settings.maxRateJumpPct);
  if (jumps.length) {
    return {
      status: "held",
      heldCount: changes.length,
      updatedCount: 0,
      message: `${jumps.map((j) => `The ${j.metal} price moved ${j.pct > 0 ? "+" : ""}${j.pct}%`).join(" and ")} since yesterday, more than your ${settings.maxRateJumpPct}% limit, so no prices were changed automatically. If the price is right, update on Price Updates.`,
    };
  }
  const held = changes.filter((r) => r.flagged);
  const toApply = changes.filter((r) => !r.flagged);

  const result = toApply.length
    ? await applyPrices(admin, toApply)
    : { updated: [], errors: [] };
  let runId = null;
  if (result.updated.length || result.errors.length) {
    const run = await recordRun(shop, {
      kind: "auto",
      gram24: prices.gram24,
      usdPerOunce: prices.usdPerOunce,
      usdEgp: prices.usdRate,
      ...result,
    });
    runId = run?.id ?? null;
  }

  const parts = [];
  if (result.errors.length)
    parts.push(
      `${result.errors.length} product${result.errors.length === 1 ? "" : "s"} could not be updated: ${result.errors.map((e) => `${e.productTitle} (${e.message})`).join("; ")}.`,
    );
  if (held.length)
    parts.push(
      `${held.length} price${held.length === 1 ? "" : "s"} would change by more than ${settings.warnChangePct}% and ${held.length === 1 ? "is" : "are"} waiting for you on Price Updates.`,
    );
  const belowMin = plan.skipped.filter((k) => k.belowMinimum).length;
  if (belowMin)
    parts.push(
      `${belowMin} price${belowMin === 1 ? " was" : "s were"} not changed because ${belowMin === 1 ? "it is" : "they are"} below your minimum price rules (see Products).`,
    );
  if (!changes.length && !belowMin)
    parts.push("All prices already match. Nothing to change.");
  return {
    status: result.errors.length ? "failed" : held.length ? "held" : "applied",
    message: parts.join(" ") || null,
    updatedCount: result.updated.length,
    heldCount: held.length,
    runId,
  };
}

// A skipped run (price feed down, exchange rate out of date...) is tried again,
// at most MAX_ATTEMPTS times in all, RETRY_AFTER_MS apart, while it is still due.
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 9 * 60 * 1000;

async function claimRetry(shop, slot, now) {
  const row = await db.autoRun.findUnique({
    where: { shop_slot: { shop, slot } },
  });
  if (
    !row ||
    row.status !== "skipped" ||
    row.attempts >= MAX_ATTEMPTS ||
    now - row.lastTryAt.getTime() < RETRY_AFTER_MS
  )
    return null;
  // Only one caller wins the claim.
  const claimed = await db.autoRun.updateMany({
    where: { id: row.id, status: "skipped", attempts: row.attempts },
    data: {
      status: "running",
      attempts: row.attempts + 1,
      lastTryAt: new Date(now),
    },
  });
  return claimed.count ? row : null;
}

async function runOne(shop, now) {
  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    return; // App uninstalled or never finished installing.
  }
  const settings = await loadSettings(admin, shop);
  if (!settings.auto.enabled) return;
  const shopInfo = await fetchShopInfo(admin, shop);
  const slot = dueSlot(settings.auto.times, shopInfo.timeZone || "UTC", now);
  if (!slot) return;

  // Claim this scheduled time. If the row exists, it already ran (or is running),
  // unless it was skipped: then it is tried again on a later timer call.
  let row;
  try {
    row = await db.autoRun.create({ data: { shop, slot } });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    row = await claimRetry(shop, slot, now);
    if (!row) return;
  }

  let outcome;
  try {
    outcome = await runShop(shop, admin, settings, shopInfo);
  } catch (error) {
    console.error(`[gold-price] automatic update failed for ${shop}:`, error);
    outcome = {
      status: "failed",
      message: `Something went wrong: ${error.message}`,
    };
  }
  await db.autoRun.update({ where: { id: row.id }, data: outcome });
  const label = {
    applied: outcome.updatedCount
      ? `Updated ${outcome.updatedCount} price${outcome.updatedCount === 1 ? "" : "s"}.`
      : "No changes needed.",
    held: `Updated ${outcome.updatedCount || 0}, held ${outcome.heldCount || 0} for review.`,
    skipped: "Skipped.",
    failed: "Had problems.",
  }[outcome.status];
  await logActivity(
    shop,
    "Automatic",
    "auto",
    `Scheduled update: ${label}${outcome.message ? ` ${outcome.message}` : ""}`,
  );
}

const TIMER_KEY = "timerLastCall";

/** Remember when the outside timer last called, so pages can show it is working. */
export async function noteTimerCall() {
  const value = new Date().toISOString();
  try {
    await db.appState.upsert({
      where: { key: TIMER_KEY },
      create: { key: TIMER_KEY, value },
      update: { value },
    });
  } catch (error) {
    console.error("[gold-price] could not note timer call:", error.message);
  }
}

async function timerLastCall() {
  try {
    const row = await db.appState.findUnique({ where: { key: TIMER_KEY } });
    return row?.value || null;
  } catch {
    return null;
  }
}

/** Run every store that is due. Calls that overlap a run in progress do nothing. */
export async function runDueShops(now = Date.now()) {
  if (running) return { started: false };
  running = true;
  try {
    for (const shop of await enabledShops()) {
      try {
        await runOne(shop, now);
      } catch (error) {
        console.error(
          `[gold-price] automatic update error for ${shop}:`,
          error,
        );
      }
    }
  } finally {
    running = false;
  }
  return { started: true };
}

/** The latest automatic runs for a store, newest first. */
export async function recentAutoRuns(shop, take = 5) {
  try {
    const rows = await db.autoRun.findMany({
      where: { shop },
      orderBy: { slot: "desc" },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      slot: r.slot.toISOString(),
      status: r.status,
      message: r.message,
      updatedCount: r.updatedCount,
      heldCount: r.heldCount,
      runId: r.runId,
      attempts: r.attempts,
    }));
  } catch (error) {
    console.error("[gold-price] could not load automatic runs:", error.message);
    return [];
  }
}

/**
 * What the pages show about automatic updates: on/off, the next scheduled time, the
 * latest automatic run, and when the merchant last applied prices by hand.
 */
export async function autoSummary(shop, settings, timeZone) {
  const [[latest], timerAt] = await Promise.all([
    recentAutoRuns(shop, 1),
    timerLastCall(),
  ]);
  let lastManualAt = null;
  try {
    const manual = await db.priceRun.findFirst({
      where: { shop, kind: "apply" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    lastManualAt = manual?.createdAt.toISOString() || null;
  } catch (error) {
    console.error(
      "[gold-price] could not load last manual run:",
      error.message,
    );
  }
  const next =
    settings.auto.enabled && settings.auto.times.length
      ? nextSlot(settings.auto.times, timeZone || "UTC")
      : null;
  return {
    enabled: settings.auto.enabled,
    times: settings.auto.times,
    next: next ? next.toISOString() : null,
    latest: latest || null,
    lastManualAt,
    timerAt,
    // No call in the last 30 minutes: the timer is probably not set up or failing.
    timerStale: !timerAt || Date.now() - Date.parse(timerAt) > 30 * 60 * 1000,
  };
}
