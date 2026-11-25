// Live global gold and silver prices (XAU/USD, XAG/USD spot) and the USD -> EGP exchange rate.
//
// Sources (all free, no API key):
//   Gold spot:  https://api.gold-api.com/price/XAU            (live, updates every few seconds)
//   Silver spot: https://api.gold-api.com/price/XAG           (live)
//   USD/EGP:    https://open.er-api.com/v6/latest/USD         (updates daily)
//   Fallback:   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api  (daily XAU + EGP rates)
//
// Results are cached in memory so every dashboard poll does not hit the providers.

import db from "../db.server";

const GOLD_TTL_MS = 30 * 1000;
const FX_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

const cache = {
  gold: null, // { usdPerOunce, source, updatedAt, fetchedAt }
  silver: null, // { usdPerOunce, source, updatedAt, fetchedAt }
  fx: null, // { usdEgp, source, updatedAt, fetchedAt }
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

async function fetchFx() {
  try {
    const data = await getJson("https://open.er-api.com/v6/latest/USD");
    const rate = Number(data?.rates?.EGP);
    if (data?.result !== "success" || !(rate > 0))
      throw new Error("open.er-api.com returned no EGP rate");
    return {
      usdEgp: rate,
      source: "open.er-api.com",
      updatedAt: data.time_last_update_unix
        ? new Date(data.time_last_update_unix * 1000).toISOString()
        : new Date().toISOString(),
    };
  } catch (primaryError) {
    const { rates, date } = await fetchFallbackRates();
    const egp = Number(rates?.egp);
    if (!(egp > 0)) throw primaryError;
    return {
      usdEgp: egp,
      source: "currency-api (daily)",
      updatedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
    };
  }
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
 * Returns the latest live market data:
 * { usdPerOunce, usdEgp, egpPerGram24, gold: {...}, fx: {...}, ok, fetchedAt }
 */
export async function getLiveGoldPrice() {
  const [gold, silver, fx] = await Promise.all([
    cached("gold", GOLD_TTL_MS, fetchGold),
    cached("silver", GOLD_TTL_MS, fetchSilver),
    cached("fx", FX_TTL_MS, fetchFx),
  ]);
  const usdPerOunce = gold.usdPerOunce || null;
  const silverUsdPerOunce = silver.usdPerOunce || null;
  const usdEgp = fx.usdEgp || null;
  const live = {
    ok: Boolean(usdPerOunce && usdEgp),
    usdPerOunce,
    silverUsdPerOunce,
    usdEgp,
    egpPerGram24:
      usdPerOunce && usdEgp ? (usdPerOunce / 31.1034768) * usdEgp : null,
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
      source: fx.source || null,
      updatedAt: fx.updatedAt || null,
      stale: fx.stale,
      error: fx.error || null,
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
let lastHistoryWrite = 0;

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
  if (now - lastHistoryWrite < HISTORY_EVERY_MS || !live.usdEgp) return;
  lastHistoryWrite = now;
  const day = cairoDay();
  const rows = [
    ["gold", live.usdPerOunce, live.gold.source],
    ["silver", live.silverUsdPerOunce, live.silver.source],
  ].filter(([, usd]) => usd > 0);
  Promise.all(
    rows.map(([metal, usdPerOunce, source]) => {
      const data = {
        usdPerOunce,
        usdEgp: live.usdEgp,
        egpPerGram: (usdPerOunce / 31.1034768) * live.usdEgp,
        source: source || "unknown",
      };
      return db.metalRate.upsert({
        where: { metal_day: { metal, day } },
        create: { metal, day, ...data },
        update: data,
      });
    }),
  ).catch((error) => {
    console.error("[gold-price] could not save rate history:", error.message);
  });
}

/** Last `days` days of history, newest first: [{ day, gold, silver }] (EGP per gram, pure metal, no premium). */
export async function recentRates(days = 14) {
  try {
    const rows = await db.metalRate.findMany({
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
