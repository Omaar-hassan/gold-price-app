// UI pieces shared by the app's pages.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Thumbnail,
  useIndexResourceState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { shopFormat } from "../lib/format";
import { ORIGIN_LABELS, PURITIES, purityLabel } from "../lib/pricing";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ShopContext = createContext(shopFormat());
export const useShop = () => useContext(ShopContext);
export const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
export const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export function timeAgo(iso, now) {
  if (!iso) return "unknown";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

const STYLES = `
  .gpe-hero { background: linear-gradient(135deg, #2b2100 0%, #5c4300 45%, #b8860b 100%); border-radius: 16px; padding: 24px; color: #fff; }
  .gpe-hero-label { opacity: .8; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  .gpe-hero-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: 24px; }
  .gpe-hero-grid > * { min-width: 0; }
  @media (max-width: 900px) { .gpe-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 480px) { .gpe-hero-grid { grid-template-columns: minmax(0, 1fr); } }
  .gpe-hero-price { font-size: clamp(28px, 3.4vw, 40px); font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .gpe-hero-price.small { font-size: clamp(22px, 2.2vw, 28px); }
  .gpe-hero-sub { opacity: .85; font-size: 14px; font-variant-numeric: tabular-nums; }
  .gpe-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,.15); border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
  .gpe-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 0 rgba(74,222,128,.7); animation: gpe-pulse 2s infinite; }
  .gpe-dot.stale { background: #fbbf24; animation: none; }
  .gpe-dot.down { background: #f87171; animation: none; }
  @keyframes gpe-pulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.7); } 70% { box-shadow: 0 0 0 8px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
  .gpe-up { color: #4ade80; font-weight: 600; }
  .gpe-downtxt { color: #fca5a5; font-weight: 600; }
  .gpe-karat { border: 1px solid var(--p-color-border); border-radius: 12px; padding: 14px; background: var(--p-color-bg-surface); }
  .gpe-karat-k { font-size: 13px; font-weight: 600; color: #8a6d1d; }
  .gpe-karat-k.silver { color: #5f6b7a; }
  .gpe-karat-p { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .gpe-scroll { overflow-x: auto; margin: 0 -4px; }
  .gpe-matrix { width: 100%; min-width: 520px; border-collapse: collapse; }
  .gpe-matrix th { text-align: left; font-weight: 600; font-size: 13px; padding: 6px 8px; color: var(--p-color-text-secondary); }
  .gpe-matrix td { padding: 4px 8px; vertical-align: middle; }
  .gpe-matrix tr + tr td { border-top: 1px solid var(--p-color-border-secondary); }
  .gpe-num { font-variant-numeric: tabular-nums; }
  .gpe-stat-link { color: inherit; text-decoration: none; display: block; }
  .gpe-stat-link:hover .gpe-stat { background: var(--p-color-bg-surface-secondary-hover); }
  .gpe-spark { width: 100%; height: 48px; display: block; }
`;

/** Page frame: store formatting context, Shopify title bar and the shared styles. */
export function AppPage({ shop, title, children, ...pageProps }) {
  const format = useMemo(() => shopFormat(shop), [shop]);
  return (
    <ShopContext.Provider value={format}>
      <Page title={title} {...pageProps}>
        <TitleBar title={title} />
        {/* As raw HTML: React escapes ">" in style text on the server, which broke hydration. */}
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        {children}
        <Box paddingBlockEnd="800" />
      </Page>
    </ShopContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Data hooks (plain fetch: a network blip shows a message, never the error screen)
// ---------------------------------------------------------------------------

/** The live price, refreshed every 30 seconds. A failed refresh keeps the last price. */
export function useLivePrice(initial) {
  const [live, setLive] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const firstSpot = useRef(initial.usdPerOunce);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/app/gold-price", { cache: "no-store" });
      if (res.ok) {
        const next = await res.json();
        if (next && next.fetchedAt) setLive(next);
      }
    } catch (error) {
      console.warn("Live price refresh failed, will retry:", error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const poll = setInterval(refresh, 30000);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const trend =
    live.usdPerOunce &&
    firstSpot.current &&
    Math.abs(live.usdPerOunce - firstSpot.current) >= 0.01
      ? live.usdPerOunce - firstSpot.current
      : 0;
  return { live, refresh, refreshing, now, trend };
}

/**
 * Post an action (save, preview, apply, undo) to the current page's server action.
 * url: the page's data URL, e.g. "/app/pricing?_data=routes%2Fapp.pricing".
 * onResult gets the JSON reply, or { error } on failure.
 */
export function usePageAction(url, onResult) {
  const [busyIntent, setBusyIntent] = useState(null);
  const busyRef = useRef(false);
  const submit = useCallback(
    async (payload) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyIntent(payload.intent);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => null);
        if (body && typeof body === "object" && (body.intent || body.error)) {
          onResult(body);
        } else {
          onResult({
            error: `The server could not finish this (error ${res.status}). Please try again.`,
          });
        }
      } catch (error) {
        console.warn("Action failed:", error);
        onResult({
          error:
            payload.intent === "apply" || payload.intent === "undo"
              ? "Lost the connection to the app server. Some prices may or may not have changed: reload the page and check History before trying again."
              : "Lost the connection to the app server. It may be waking up: please wait a few seconds and try again.",
        });
      } finally {
        busyRef.current = false;
        setBusyIntent(null);
      }
    },
    [url, onResult],
  );
  return { submit, busyIntent, busy: busyIntent !== null };
}

/**
 * Editable settings for a page that owns `keys`. Saves only those keys, so pages
 * never overwrite each other's settings.
 */
export function useSettingsForm(initial, keys, url) {
  const [settings, setSettings] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [notice, setNotice] = useState(null);
  const [savedCurrency, setSavedCurrency] = useState(initial.currency);
  const onResult = useCallback((d) => {
    if (d.error) return setNotice({ tone: "critical", title: d.error });
    if (d.intent === "save") {
      setSaved(d.settings);
      setSettings(d.settings);
      if (d.settings?.currency) setSavedCurrency(d.settings.currency);
      setNotice({ tone: "success", title: "Saved." });
    }
  }, []);
  const { submit, busyIntent } = usePageAction(url, onResult);
  const dirty = keys.some(
    (k) => JSON.stringify(settings[k]) !== JSON.stringify(saved[k]),
  );
  const save = () =>
    submit({
      intent: "save",
      settings: Object.fromEntries(keys.map((k) => [k, settings[k]])),
    });
  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));
  return {
    settings,
    setSettings,
    set,
    save,
    saving: busyIntent === "save",
    dirty,
    discard: () => setSettings(saved),
    notice,
    setNotice,
    savedCurrency,
  };
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

/** Warnings that stop price updates: price service down, currency problems, old rate. */
export function ShopAlerts({ live, settings, shop, savedCurrency }) {
  const { currency, formatDate } = useShop();
  const saved = savedCurrency ?? settings.currency;
  const mismatch = shop.currencyKnown && saved && saved !== currency;
  const rateOutdated =
    currency !== "USD" &&
    live.fx.outdated &&
    !settings.usdEgpOverride &&
    settings.includeKarats.some(
      (k) => !(Number(settings.karatOverrides?.[k]) > 0),
    );
  return (
    <>
      {!live.ok && (
        <Banner tone="warning" title="Live price unavailable">
          <p>
            We couldn&apos;t reach the gold price service (
            {live.gold.error || live.fx.error || "unknown error"}). You can
            still update prices by entering a manual price per gram on the Metal
            Rates page.
          </p>
        </Banner>
      )}
      {!shop.currencyKnown && (
        <Banner tone="critical" title="Store currency unknown">
          <p>
            We couldn&apos;t read your store currency from Shopify, so prices
            are shown in {currency} for now and price updates are paused. Reload
            the page in a minute.
          </p>
        </Banner>
      )}
      {mismatch && (
        <Banner tone="critical" title="Your store currency has changed">
          <p>
            Your saved amounts (making charges, fees, discount, manual prices)
            were entered in {saved}, but your store now uses {currency}. Check
            the amounts on the Metal Rates and Pricing pages, then press Save to
            confirm they are in {currency}. Price updates are paused until then.
          </p>
        </Banner>
      )}
      {live.ok && rateOutdated && (
        <Banner tone="critical" title={`USD → ${currency} rate is out of date`}>
          <p>
            The exchange rate was last updated{" "}
            {live.fx.updatedAt
              ? formatDate(live.fx.updatedAt)
              : "at an unknown time"}
            , so price updates are paused instead of using an old rate. This
            usually fixes itself within a day, or you can enter a manual
            exchange rate on the Metal Rates page.
          </p>
        </Banner>
      )}
    </>
  );
}

export function NoticeBanner({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <Banner tone={notice.tone} title={notice.title} onDismiss={onDismiss}>
      {notice.errors?.length > 0 && (
        <BlockStack gap="100">
          {notice.errors.map((e) => (
            <Text as="p" key={e.productId}>
              {e.productTitle}: {e.message}
            </Text>
          ))}
        </BlockStack>
      )}
    </Banner>
  );
}

/** Save / Discard row for settings pages. */
export function SaveBar({ form }) {
  return (
    <InlineStack align="end" gap="200" blockAlign="center">
      {form.dirty && <Badge tone="attention">Unsaved changes</Badge>}
      <Button onClick={form.discard} disabled={!form.dirty || form.saving}>
        Discard
      </Button>
      <Button
        variant="primary"
        onClick={form.save}
        loading={form.saving}
        disabled={!form.dirty}
      >
        Save
      </Button>
    </InlineStack>
  );
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export function LiveHero({ live, prices, now, trend, onRefresh, refreshing }) {
  const { money, currency } = useShop();
  const status = !live.ok
    ? "down"
    : live.gold.stale || live.fx.stale || live.fx.outdated
      ? "stale"
      : "live";
  const statusText =
    status === "live" ? "Live" : status === "stale" ? "Delayed" : "Offline";
  return (
    <div className="gpe-hero">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <span className="gpe-chip">
            <span className={`gpe-dot ${status === "live" ? "" : status}`} />
            {statusText} · updated{" "}
            {timeAgo(live.gold.updatedAt || live.fetchedAt, now)}
          </span>
          <Button size="slim" onClick={onRefresh} loading={refreshing}>
            Refresh
          </Button>
        </InlineStack>

        <div className="gpe-hero-grid">
          <BlockStack gap="100">
            <span className="gpe-hero-label">24k gold · per gram</span>
            <span className="gpe-hero-price">
              {prices.gram24 > 0 ? money.format(prices.gram24) : "—"}
            </span>
            {trend ? (
              <span className={trend > 0 ? "gpe-up" : "gpe-downtxt"}>
                {trend > 0 ? "▲" : "▼"} {usd.format(Math.abs(trend))} /oz since
                you opened the page
              </span>
            ) : (
              <span className="gpe-hero-sub">Includes your market premium</span>
            )}
          </BlockStack>
          <BlockStack gap="100">
            <span className="gpe-hero-label">Fine silver · per gram</span>
            <span className="gpe-hero-price small">
              {prices.gramSilver > 0 ? money.format(prices.gramSilver) : "—"}
            </span>
            <span className="gpe-hero-sub">
              {live.silverUsdPerOunce
                ? `${usd.format(live.silverUsdPerOunce)} /oz (XAG)`
                : live.silver?.error
                  ? "Silver price unavailable"
                  : "—"}
            </span>
          </BlockStack>
          <BlockStack gap="100">
            <span className="gpe-hero-label">Global spot (XAU/USD)</span>
            <span className="gpe-hero-price small">
              {live.usdPerOunce ? usd.format(live.usdPerOunce) : "—"}
            </span>
            <span className="gpe-hero-sub">
              per troy ounce · {live.gold.source || "no source"}
            </span>
          </BlockStack>
          <BlockStack gap="100">
            <span className="gpe-hero-label">USD → {currency}</span>
            <span className="gpe-hero-price small">
              {prices.usdRate ? num.format(prices.usdRate) : "—"}
            </span>
            <span className="gpe-hero-sub">
              {live.fx.source || "no source"}
            </span>
          </BlockStack>
        </div>
      </BlockStack>
    </div>
  );
}

/** Price-per-gram cards. onlyIncluded: show just the purities being updated. */
export function KaratCards({ prices, settings, onlyIncluded = false }) {
  const { money0 } = useShop();
  const list = PURITIES.filter(
    (p) => !onlyIncluded || settings.includeKarats.includes(p.key),
  );
  if (!list.length)
    return (
      <Text as="p" tone="subdued">
        No karats are switched on. Choose them in Settings.
      </Text>
    );
  const card = (p) => {
    const price = prices.byKarat[p.key];
    const included = settings.includeKarats.includes(p.key);
    return (
      <div
        className="gpe-karat"
        key={p.key}
        style={{ opacity: included ? 1 : 0.55 }}
      >
        <BlockStack gap="100">
          <InlineStack align="space-between" blockAlign="center">
            <span className={`gpe-karat-k ${p.metal}`}>{p.label}</span>
            {price.source === "manual" ? (
              <Badge tone="attention">Manual</Badge>
            ) : (
              <Badge tone="success">Live</Badge>
            )}
          </InlineStack>
          <span className="gpe-karat-p">
            {price.price > 0 ? money0.format(price.price) : "—"}
          </span>
          <Text as="span" variant="bodySm" tone="subdued">
            per gram · {Math.round(p.fraction * 1000) / 10}% {p.metal}
          </Text>
        </BlockStack>
      </div>
    );
  };
  if (onlyIncluded)
    return (
      <InlineGrid columns={{ xs: 2, sm: 3, lg: 4 }} gap="300">
        {list.map(card)}
      </InlineGrid>
    );
  const gold = list.filter((p) => p.metal === "gold");
  const silver = list.filter((p) => p.metal === "silver");
  return (
    <BlockStack gap="300">
      {gold.length > 0 && (
        <InlineGrid columns={{ xs: 2, sm: 4, md: 7 }} gap="300">
          {gold.map(card)}
        </InlineGrid>
      )}
      {silver.length > 0 && (
        <InlineGrid columns={{ xs: 2, sm: 4, md: 7 }} gap="300">
          {silver.map(card)}
        </InlineGrid>
      )}
    </BlockStack>
  );
}

export function RateHistory({ history }) {
  const { money, money0 } = useShop();
  if (!history?.length)
    return (
      <Text as="p" tone="subdued">
        Prices are saved once a day while the app is open. Check back tomorrow.
      </Text>
    );
  return (
    <div className="gpe-scroll">
      <table className="gpe-matrix" style={{ minWidth: 0 }}>
        <thead>
          <tr>
            <th>Day</th>
            <th>24k / g</th>
            <th>Silver 999 / g</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.day}>
              <td>{h.day}</td>
              <td>{h.gold ? money0.format(h.gold) : "—"}</td>
              <td>{h.silver ? money.format(h.silver) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tiny line chart of daily 24k prices (oldest left). */
export function Sparkline({ history }) {
  const points = [...(history || [])]
    .reverse()
    .map((h) => h.gold)
    .filter((v) => v > 0);
  if (points.length < 2)
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        The chart appears after two days of prices.
      </Text>
    );
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 200;
  const h = 48;
  const d = points
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`,
    )
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg
      className="gpe-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="24k price trend"
    >
      <path
        d={d}
        fill="none"
        stroke={up ? "#2e7d32" : "#c62828"}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Stat({ label, value, tone, help }) {
  return (
    <div className="gpe-stat">
      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
        <BlockStack gap="050">
          <Text as="span" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="span" variant="headingLg" tone={tone}>
            {value}
          </Text>
          {help && (
            <Text as="span" variant="bodySm" tone="subdued">
              {help}
            </Text>
          )}
        </BlockStack>
      </Box>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview tables
// ---------------------------------------------------------------------------

function ChangeBadge({ row }) {
  if (row.unchanged) return <Badge>No change</Badge>;
  if (row.changePct === null) return <Badge tone="info">New price</Badge>;
  const pct = `${row.changePct > 0 ? "+" : ""}${row.changePct.toFixed(1)}%`;
  if (row.flagged) return <Badge tone="critical">{pct}</Badge>;
  return <Badge tone={row.changePct > 0 ? "success" : "warning"}>{pct}</Badge>;
}

export function PreviewTable({ rows, selected, onSelect }) {
  const { money } = useShop();
  const resourceName = { singular: "variant", plural: "variants" };
  const items = rows.map((r) => ({ ...r, id: r.variantId }));
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(items, {
      selectedResources: selected,
    });

  useEffect(() => {
    onSelect(selectedResources);
  }, [selectedResources, onSelect]);

  return (
    <IndexTable
      resourceName={resourceName}
      itemCount={items.length}
      selectedItemsCount={
        allResourcesSelected ? "All" : selectedResources.length
      }
      onSelectionChange={handleSelectionChange}
      headings={[
        { title: "Product" },
        { title: "Karat" },
        { title: "Origin" },
        { title: "Weight" },
        { title: "Current", alignment: "end" },
        { title: "New", alignment: "end" },
        { title: "Change", alignment: "end" },
      ]}
    >
      {items.map((r, index) => (
        <IndexTable.Row
          id={r.id}
          key={r.id}
          position={index}
          selected={selectedResources.includes(r.id)}
          tone={r.flagged ? "critical" : undefined}
        >
          <IndexTable.Cell>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Thumbnail
                size="small"
                alt=""
                source={r.image || "data:image/gif;base64,R0lGODlhAQABAAAAACw="}
              />
              <BlockStack gap="050">
                <Text as="span" fontWeight="semibold">
                  {r.productTitle}
                </Text>
                {(r.variantTitle || r.sku) && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {[r.variantTitle, r.sku].filter(Boolean).join(" · ")}
                  </Text>
                )}
              </BlockStack>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>{purityLabel(r.karat)}</IndexTable.Cell>
          <IndexTable.Cell>
            {ORIGIN_LABELS[r.origin]}
            {r.originGuessed && (
              <Text as="span" variant="bodySm" tone="subdued">
                {" "}
                (assumed)
              </Text>
            )}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <span className="gpe-num">{num.format(r.weight)} g</span>
              <Text as="span" variant="bodySm" tone="subdued">
                from {r.weightSource}
              </Text>
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" alignment="end" numeric tone="subdued">
              {money.format(r.currentPrice)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" alignment="end" numeric fontWeight="semibold">
              {money.format(r.newPrice)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack align="end">
              <ChangeBadge row={r} />
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

export function SkippedTable({ skipped }) {
  if (!skipped.length) {
    return (
      <Box padding="400">
        <Text as="p" tone="subdued">
          Every product was matched.
        </Text>
      </Box>
    );
  }
  return (
    <IndexTable
      resourceName={{ singular: "variant", plural: "variants" }}
      itemCount={skipped.length}
      selectable={false}
      headings={[
        { title: "Product" },
        { title: "Reason" },
        { title: "Karat" },
        { title: "Origin" },
        { title: "Weight" },
      ]}
    >
      {skipped.map((r, i) => (
        <IndexTable.Row id={r.variantId} key={r.variantId} position={i}>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text as="span" fontWeight="semibold">
                {r.productTitle}
              </Text>
              {(r.variantTitle || r.sku) && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {[r.variantTitle, r.sku].filter(Boolean).join(" · ")}
                </Text>
              )}
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge tone="warning">{r.reason}</Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            {r.karat ? purityLabel(r.karat) : "—"}
          </IndexTable.Cell>
          <IndexTable.Cell>
            {r.origin ? ORIGIN_LABELS[r.origin] : "—"}
          </IndexTable.Cell>
          <IndexTable.Cell>
            {r.weight ? `${num.format(r.weight)} g` : "—"}
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

export const runLabel = (kind) =>
  kind === "undo" ? "Undo" : kind === "auto" ? "Automatic update" : "Update";

/**
 * Tells the merchant when the latest automatic update needs them: big changes held
 * for review, or a run that was skipped or failed. Hidden once a later manual update
 * has run. reviewAction: Banner action (omit on the Price Updates page itself).
 */
export function AutoRunBanner({ autoRun, lastManualAt, reviewAction }) {
  const { formatDate } = useShop();
  if (!autoRun || !["held", "skipped", "failed"].includes(autoRun.status))
    return null;
  if (lastManualAt && lastManualAt > autoRun.slot) return null;
  const when = formatDate(autoRun.slot);
  const title =
    autoRun.status === "held"
      ? `${autoRun.heldCount} big price change${autoRun.heldCount === 1 ? " is" : "s are"} waiting for you`
      : autoRun.status === "skipped"
        ? "The last automatic update was skipped"
        : "The last automatic update had problems";
  return (
    <Banner
      tone={autoRun.status === "held" ? "warning" : "critical"}
      title={title}
      action={reviewAction}
    >
      <p>
        Automatic update at {when}
        {autoRun.updatedCount
          ? `: ${autoRun.updatedCount} price${autoRun.updatedCount === 1 ? "" : "s"} updated. `
          : ". "}
        {autoRun.status === "held"
          ? "Press Preview new prices on Price Updates, check the highlighted rows, then apply the ones you want."
          : autoRun.message}
      </p>
    </Banner>
  );
}

const AUTO_STATUS = {
  running: { label: "Running", tone: "info" },
  applied: { label: "Done", tone: "success" },
  held: { label: "Waiting for you", tone: "warning" },
  skipped: { label: "Skipped", tone: "critical" },
  failed: { label: "Problem", tone: "critical" },
};

/** Badge label and tone for an automatic run. */
export function autoStatus(run) {
  if (run.status === "applied" && !run.updatedCount)
    return { label: "No changes", tone: undefined };
  return AUTO_STATUS[run.status] || { label: run.status, tone: undefined };
}

/** When the outside timer last called the app, so the merchant can see it works. */
export function TimerLine({ auto }) {
  const { formatDate } = useShop();
  return (
    <Text
      as="p"
      variant="bodySm"
      tone={auto.timerStale ? "caution" : "subdued"}
    >
      {auto.timerAt
        ? `Timer last checked in: ${formatDate(auto.timerAt)}`
        : "The timer hasn't checked in yet."}
      {auto.timerStale && auto.timerAt
        ? " That was over 30 minutes ago, so check your timer job."
        : ""}
    </Text>
  );
}
