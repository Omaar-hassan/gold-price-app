// Live global gold and silver prices (XAU/USD, XAG/USD spot) and the exchange rate
// from USD to the store's own Shopify currency (EGP, AED, EUR, ...).
//
// Sources (all free, no API key):
//   Gold spot:  https://api.gold-api.com/price/XAU            (live, updates every few seconds)
//   Silver spot: https://api.gold-api.com/price/XAG           (live)
//   USD rates:  https://open.er-api.com/v6/latest/USD         (all currencies, updates daily)
//   Fallback:   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api  (daily XAU + all currencies)
//
// Results are cached in memory so every dashboard poll does not hit the providers.

import db from "../db.server";

const GOLD_TTL_MS = 30 * 1000;
const FX_TTL_MS = 60 * 60 * 1000;
// A rate older than this is "outdated": the dashboard warns and price updates are
// blocked (unless the merchant enters a manual rate) instead of using it silently.
// The providers publish once a day, so a healthy rate is at most ~24 hours old.
export const FX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

const cache = {
  gold: null, // { usdPerOunce, source, updatedAt, fetchedAt }
  silver: null, // { usdPerOunce, source, updatedAt, fetchedAt }
  fx: null, // { rates: { EGP: 47.6, AED: 3.67, ... }, source, updatedAt, fetchedAt }
};

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

const FALLBACK_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];

async function fetchFallbackRates() {
  let lastError;
  for (const url of FALLBACK_URLS) {
    try {
      const data = await getJson(url);
      if (data?.usd) return { rates: data.usd, date: data.date };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Fallback rates unavailable");
}

async function fetchSpot(symbol) {
  try {
    const data = await getJson(`https://api.gold-api.com/price/${symbol}`);
    const price = Number(data?.price);
    if (!(price > 0))
      throw new Error(`gold-api.com returned no ${symbol} price`);
    return {
      usdPerOunce: price,
      source: "gold-api.com",
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  } catch (primaryError) {
    // Fallback: currency-api lists how many ounces of the metal 1 USD buys.
    const { rates, date } = await fetchFallbackRates();
    const perUsd = Number(rates?.[symbol.toLowerCase()]);
    if (!(perUsd > 0)) throw primaryError;
    return {
      usdPerOunce: 1 / perUsd,
      source: "currency-api (daily)",
      updatedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
    };
  }
}

const fetchGold = () => fetchSpot("XAU");
const fetchSilver = () => fetchSpot("XAG");

// One request gives the USD rate for every currency, so all stores share it.
async function fetchFx() {
  try {
    const data = await getJson("https://open.er-api.com/v6/latest/USD");
    if (data?.result !== "success" || !data.rates || !(data.rates.EGP > 0))
      throw new Error("open.er-api.com returned no rates");
    return {
      rates: data.rates,
      source: "open.er-api.com",
      updatedAt: data.time_last_update_unix
        ? new Date(data.time_last_update_unix * 1000).toISOString()
        : new Date().toISOString(),
    };
  } catch (primaryError) {
    const { rates, date } = await fetchFallbackRates();
    if (!rates || !(Number(rates.egp) > 0)) throw primaryError;
    const upper = {};
    for (const [code, value] of Object.entries(rates))
      if (/^[a-z]{3}$/.test(code)) upper[code.toUpperCase()] = Number(value);
    return {
      rates: upper,
      source: "currency-api (daily)",
      updatedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
    };
  }
}

/** USD -> currency from the shared rates table: { rate, error }. */
function rateFor(fx, currency) {
  if (currency === "USD") return { rate: 1 };
  const rate = Number(fx?.rates?.[currency]);
  if (rate > 0) return { rate };
  if (!fx?.rates)
    return { rate: null, error: fx?.error || "rates unavailable" };
  return { rate: null, error: `no exchange rate published for ${currency}` };
}

async function cached(key, ttl, fetcher) {
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.fetchedAt < ttl) return { ...hit, stale: false };
  try {
    const fresh = { ...(await fetcher()), fetchedAt: now };
    cache[key] = fresh;
    return { ...fresh, stale: false };
  } catch (error) {
    console.error(`[gold-price] ${key} fetch failed:`, error.message);
    if (hit) return { ...hit, stale: true, error: error.message };
    return { stale: true, error: error.message };
  }
}

/**
 * Returns the latest live market data, priced in `currency` (the store's Shopify
 * currency, e.g. "EGP"):
 * { currency, usdPerOunce, silverUsdPerOunce, usdRate, perGram24, gold, silver, fx, ok, fetchedAt }
 * usdRate = how many units of `currency` one US dollar buys (1 for USD).
 * fx.outdated = the rate is older than FX_MAX_AGE_MS (or missing).
 */
export async function getLiveGoldPrice(currency = "EGP") {
  const [gold, silver, fx] = await Promise.all([
    cached("gold", GOLD_TTL_MS, fetchGold),
    cached("silver", GOLD_TTL_MS, fetchSilver),
    cached("fx", FX_TTL_MS, fetchFx),
  ]);
  const usdPerOunce = gold.usdPerOunce || null;
  const silverUsdPerOunce = silver.usdPerOunce || null;
  const { rate, error: rateError } = rateFor(fx, currency);
  const usdRate = rate || null;
  const fxUpdatedAt = currency === "USD" ? null : fx.updatedAt || null;
  const outdated =
    currency !== "USD" &&
    (!usdRate ||
      !fxUpdatedAt ||
      Date.now() - new Date(fxUpdatedAt).getTime() > FX_MAX_AGE_MS);
  const live = {
    ok: Boolean(usdPerOunce && usdRate),
    currency,
    usdPerOunce,
    silverUsdPerOunce,
    usdRate,
    perGram24:
      usdPerOunce && usdRate ? (usdPerOunce / 31.1034768) * usdRate : null,
    gold: {
      source: gold.source || null,
      updatedAt: gold.updatedAt || null,
      stale: gold.stale,
      error: gold.error || null,
    },
    silver: {
      source: silver.source || null,
      updatedAt: silver.updatedAt || null,
      stale: silver.stale,
      error: silver.error || null,
    },
    fx: {
      source: currency === "USD" ? "none needed" : fx.source || null,
      updatedAt: fxUpdatedAt,
      stale: currency === "USD" ? false : fx.stale,
      outdated,
      error: currency === "USD" ? null : rateError || fx.error || null,
    },
    fetchedAt: new Date().toISOString(),
  };
  if (!gold.stale || !silver.stale) recordDailyRates(live);
  return live;
}

// ---------------------------------------------------------------------------
// Daily history: one row per metal per day (the last price seen that day, Cairo time).
// Written at most every 10 minutes, only while someone has the app open
// (Render's free plan sleeps when idle), and never blocks the dashboard.
// ---------------------------------------------------------------------------

const HISTORY_EVERY_MS = 10 * 60 * 1000;
const lastHistoryWrite = new Map(); // currency -> time of last write

export function cairoDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recordDailyRates(live) {
  const now = Date.now();
  const { currency } = live;
  // Never record an outdated or missing rate as today's price.
  if (!live.usdRate || live.fx.outdated) return;
  if (now - (lastHistoryWrite.get(currency) || 0) < HISTORY_EVERY_MS) return;
  lastHistoryWrite.set(currency, now);
  const day = cairoDay();
  const rows = [
    ["gold", live.usdPerOunce, live.gold.source],
    ["silver", live.silverUsdPerOunce, live.silver.source],
  ].filter(([, usd]) => usd > 0);
  Promise.all(
    rows.map(([metal, usdPerOunce, source]) => {
      const data = {
        usdPerOunce,
        usdEgp: live.usdRate,
        egpPerGram: (usdPerOunce / 31.1034768) * live.usdRate,
        source: source || "unknown",
      };
      return db.metalRate.upsert({
        where: { metal_day_currency: { metal, day, currency } },
        create: { metal, day, currency, ...data },
        update: data,
      });
    }),
  ).catch((error) => {
    console.error("[gold-price] could not save rate history:", error.message);
  });
}

/** Last `days` days of history, newest first: [{ day, gold, silver }] (price per gram in `currency`, pure metal, no premium). */
export async function recentRates(days = 14, currency = "EGP") {
  try {
    const rows = await db.metalRate.findMany({
      where: { currency },
      orderBy: { day: "desc" },
      take: days * 2,
    });
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day))
        byDay.set(r.day, { day: r.day, gold: null, silver: null });
      byDay.get(r.day)[r.metal] = r.egpPerGram;
    }
    return [...byDay.values()].slice(0, days);
  } catch (error) {
    console.error("[gold-price] could not load rate history:", error.message);
    return [];
  }
}

/**
 * How much each live metal price moved since the last price recorded on an earlier
 * day. Returns [{ metal, pct }] for the metals in `metals` whose move is bigger than
 * maxPct (in either direction). Compares the price per gram in the store currency,
 * so a jump in the exchange rate counts too; falls back to the USD spot price when
 * this currency has no earlier day yet. No earlier price at all = nothing to compare.
 */
export async function rateJumps(live, metals, maxPct) {
  if (!(maxPct > 0)) return [];
  const today = cairoDay();
  const jumps = [];
  for (const metal of metals) {
    const usdNow =
      metal === "silver" ? live.silverUsdPerOunce : live.usdPerOunce;
    if (!(usdNow > 0)) continue;
    try {
      const sameCurrency = await db.metalRate.findFirst({
        where: { metal, currency: live.currency, day: { lt: today } },
        orderBy: { day: "desc" },
      });
      let pct = null;
      if (sameCurrency && live.usdRate > 0) {
        const now = (usdNow / 31.1034768) * live.usdRate;
        pct = ((now - sameCurrency.egpPerGram) / sameCurrency.egpPerGram) * 100;
      } else {
        const any = await db.metalRate.findFirst({
          where: { metal, day: { lt: today } },
          orderBy: { day: "desc" },
        });
        if (any) pct = ((usdNow - any.usdPerOunce) / any.usdPerOunce) * 100;
      }
      if (pct !== null && Math.abs(pct) > maxPct)
        jumps.push({ metal, pct: Math.round(pct * 10) / 10 });
    } catch (error) {
      console.error("[gold-price] could not compare rates:", error.message);
    }
  }
  return jumps;
}
