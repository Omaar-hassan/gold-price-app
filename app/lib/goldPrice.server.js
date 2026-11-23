// Live global gold price (XAU/USD spot) and the USD -> EGP exchange rate.
//
// Sources (all free, no API key):
//   Gold spot:  https://api.gold-api.com/price/XAU            (live, updates every few seconds)
//   USD/EGP:    https://open.er-api.com/v6/latest/USD         (updates daily)
//   Fallback:   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api  (daily XAU + EGP rates)
//
// Results are cached in memory so every dashboard poll does not hit the providers.

const GOLD_TTL_MS = 30 * 1000;
const FX_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

const cache = {
  gold: null, // { usdPerOunce, source, updatedAt, fetchedAt }
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

async function fetchGold() {
  try {
    const data = await getJson("https://api.gold-api.com/price/XAU");
    const price = Number(data?.price);
    if (!(price > 0)) throw new Error("gold-api.com returned no price");
    return {
      usdPerOunce: price,
      source: "gold-api.com",
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  } catch (primaryError) {
    // Fallback: currency-api lists how many ounces of gold 1 USD buys.
    const { rates, date } = await fetchFallbackRates();
    const xau = Number(rates?.xau);
    if (!(xau > 0)) throw primaryError;
    return {
      usdPerOunce: 1 / xau,
      source: "currency-api (daily)",
      updatedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
    };
  }
}

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
  const [gold, fx] = await Promise.all([
    cached("gold", GOLD_TTL_MS, fetchGold),
    cached("fx", FX_TTL_MS, fetchFx),
  ]);
  const usdPerOunce = gold.usdPerOunce || null;
  const usdEgp = fx.usdEgp || null;
  return {
    ok: Boolean(usdPerOunce && usdEgp),
    usdPerOunce,
    usdEgp,
    egpPerGram24:
      usdPerOunce && usdEgp ? (usdPerOunce / 31.1034768) * usdEgp : null,
    gold: {
      source: gold.source || null,
      updatedAt: gold.updatedAt || null,
      stale: gold.stale,
      error: gold.error || null,
    },
    fx: {
      source: fx.source || null,
      updatedAt: fx.updatedAt || null,
      stale: fx.stale,
      error: fx.error || null,
    },
    fetchedAt: new Date().toISOString(),
  };
}
