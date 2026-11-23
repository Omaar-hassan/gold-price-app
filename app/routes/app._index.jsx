import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  Divider,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  useIndexResourceState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice } from "../lib/goldPrice.server";
import {
  applyPrices,
  fetchAllProducts,
  getRun,
  loadSettings,
  markUndone,
  recentRuns,
  recordRun,
  saveSettings,
} from "../lib/store.server";
import {
  KARATS,
  ORIGIN_LABELS,
  buildPlan,
  karatPrices,
  normalizeSettings,
  toNumber,
} from "../lib/pricing";

export const meta = () => [{ title: "Gold Price Editor" }];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [live, settings, runs] = await Promise.all([
    getLiveGoldPrice(),
    loadSettings(admin, session.shop),
    recentRuns(session.shop),
  ]);
  return json({ live, settings, runs });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json();
  const shop = session.shop;

  try {
    if (body.intent === "save") {
      const settings = await saveSettings(admin, shop, body.settings);
      return json({ intent: "save", ok: true, settings });
    }

    if (body.intent === "preview") {
      const settings = await saveSettings(admin, shop, body.settings);
      const live = await getLiveGoldPrice();
      const prices = karatPrices(live, settings);
      const anyPrice = Object.values(prices.byKarat).some((p) => p.price > 0);
      if (!anyPrice) {
        return json(
          {
            intent: "preview",
            error:
              "The live gold price is unavailable right now. Try again in a minute, or enter manual prices per gram.",
          },
          { status: 503 },
        );
      }
      const products = await fetchAllProducts(admin);
      const images = Object.fromEntries(products.map((p) => [p.id, p.image]));
      const plan = buildPlan(products, settings, prices);
      return json({
        intent: "preview",
        ok: true,
        productCount: products.length,
        rows: plan.rows.map((r) => ({
          ...r,
          image: images[r.productId] || null,
        })),
        skipped: plan.skipped,
        snapshot: {
          gram24: prices.gram24,
          usdPerOunce: prices.usdPerOunce,
          usdEgp: prices.usdEgp,
          byKarat: prices.byKarat,
          at: new Date().toISOString(),
        },
      });
    }

    if (body.intent === "apply") {
      const changes = (body.changes || [])
        .map((c) => ({
          productId: String(c.productId),
          variantId: String(c.variantId),
          productTitle: String(c.productTitle || ""),
          variantTitle: String(c.variantTitle || ""),
          currentPrice: toNumber(c.currentPrice, 0),
          newPrice: Math.round(toNumber(c.newPrice, 0) * 100) / 100,
        }))
        .filter(
          (c) =>
            c.productId.startsWith("gid://shopify/Product/") &&
            c.variantId.startsWith("gid://shopify/ProductVariant/") &&
            c.newPrice > 0,
        );
      if (!changes.length)
        return json(
          { intent: "apply", error: "Nothing selected to update." },
          { status: 400 },
        );

      const result = await applyPrices(admin, changes);
      await recordRun(shop, {
        kind: "apply",
        gram24: toNumber(body.snapshot?.gram24, null),
        usdPerOunce: toNumber(body.snapshot?.usdPerOunce, null),
        usdEgp: toNumber(body.snapshot?.usdEgp, null),
        ...result,
      });
      return json({
        intent: "apply",
        ok: true,
        updatedCount: result.updated.length,
        errors: result.errors,
        runs: await recentRuns(shop),
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
      const result = await applyPrices(admin, changes);
      await recordRun(shop, { kind: "undo", ...result });
      if (!result.errors.length) await markUndone(run.id);
      return json({
        intent: "undo",
        ok: true,
        updatedCount: result.updated.length,
        errors: result.errors,
        runs: await recentRuns(shop),
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
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const egp = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EGP",
  maximumFractionDigits: 2,
});
const egp0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EGP",
  maximumFractionDigits: 0,
});
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

function timeAgo(iso, now) {
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

function formatDate(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------

const STYLES = `
  .gpe-hero { background: linear-gradient(135deg, #2b2100 0%, #5c4300 45%, #b8860b 100%); border-radius: 16px; padding: 24px; color: #fff; }
  .gpe-hero-label { opacity: .8; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  .gpe-hero-price { font-size: 40px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
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
  .gpe-karat-p { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .gpe-scroll { overflow-x: auto; margin: 0 -4px; }
  .gpe-matrix { width: 100%; min-width: 520px; border-collapse: collapse; }
  .gpe-matrix th { text-align: left; font-weight: 600; font-size: 13px; padding: 6px 8px; color: var(--p-color-text-secondary); }
  .gpe-matrix td { padding: 4px 8px; vertical-align: middle; }
  .gpe-matrix tr + tr td { border-top: 1px solid var(--p-color-border-secondary); }
  .gpe-num { font-variant-numeric: tabular-nums; }
`;

function LiveHero({ live, gram24, usdEgp, now, trend, onRefresh, refreshing }) {
  const status = !live.ok
    ? "down"
    : live.gold.stale || live.fx.stale
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

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <BlockStack gap="100">
            <span className="gpe-hero-label">24k gold · per gram</span>
            <span className="gpe-hero-price">
              {gram24 > 0 ? egp.format(gram24) : "—"}
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
            <span className="gpe-hero-label">Global spot (XAU/USD)</span>
            <span className="gpe-hero-price" style={{ fontSize: 28 }}>
              {live.usdPerOunce ? usd.format(live.usdPerOunce) : "—"}
            </span>
            <span className="gpe-hero-sub">
              per troy ounce · {live.gold.source || "no source"}
            </span>
          </BlockStack>
          <BlockStack gap="100">
            <span className="gpe-hero-label">USD → EGP</span>
            <span className="gpe-hero-price" style={{ fontSize: 28 }}>
              {usdEgp ? num.format(usdEgp) : "—"}
            </span>
            <span className="gpe-hero-sub">
              {live.fx.source || "no source"}
            </span>
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </div>
  );
}

function KaratCards({ prices, settings }) {
  return (
    <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }} gap="300">
      {KARATS.map((k) => {
        const p = prices.byKarat[k];
        const included = settings.includeKarats.includes(k);
        return (
          <div
            className="gpe-karat"
            key={k}
            style={{ opacity: included ? 1 : 0.55 }}
          >
            <BlockStack gap="100">
              <InlineStack align="space-between" blockAlign="center">
                <span className="gpe-karat-k">{k}k</span>
                {p.source === "manual" ? (
                  <Badge tone="attention">Manual</Badge>
                ) : (
                  <Badge tone="success">Live</Badge>
                )}
              </InlineStack>
              <span className="gpe-karat-p">
                {p.price > 0 ? egp0.format(p.price) : "—"}
              </span>
              <Text as="span" variant="bodySm" tone="subdued">
                per gram · {Math.round((Number(k) / 24) * 1000) / 10}% gold
              </Text>
            </BlockStack>
          </div>
        );
      })}
    </InlineGrid>
  );
}

function ChangeBadge({ row }) {
  if (row.unchanged) return <Badge>No change</Badge>;
  if (row.changePct === null) return <Badge tone="info">New price</Badge>;
  const pct = `${row.changePct > 0 ? "+" : ""}${row.changePct.toFixed(1)}%`;
  if (row.flagged) return <Badge tone="critical">{pct}</Badge>;
  return <Badge tone={row.changePct > 0 ? "success" : "warning"}>{pct}</Badge>;
}

function PreviewTable({ rows, selected, onSelect }) {
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
          <IndexTable.Cell>{r.karat}k</IndexTable.Cell>
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
              {egp.format(r.currentPrice)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" alignment="end" numeric fontWeight="semibold">
              {egp.format(r.newPrice)}
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

function SkippedTable({ skipped }) {
  if (!skipped.length) {
    return (
      <Box padding="400">
        <Text as="p" tone="subdued">
          Every gold product was matched.
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
          <IndexTable.Cell>{r.karat ? `${r.karat}k` : "—"}</IndexTable.Cell>
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const data = useLoaderData();
  const liveFetcher = useFetcher();
  const actionFetcher = useFetcher();

  const [live, setLive] = useState(data.live);
  const [settings, setSettings] = useState(() =>
    normalizeSettings(data.settings),
  );
  const [runs, setRuns] = useState(data.runs);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [tab, setTab] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const firstSpot = useRef(data.live.usdPerOunce);
  const lastIntent = useRef(null);

  // Poll the live price every 30 seconds and tick the "updated x ago" clock.
  const liveLoad = liveFetcher.load;
  useEffect(() => {
    const poll = setInterval(() => liveLoad("/app/gold-price"), 30000);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [liveLoad]);

  useEffect(() => {
    if (liveFetcher.data && liveFetcher.data.fetchedAt)
      setLive(liveFetcher.data);
  }, [liveFetcher.data]);

  // Handle action results.
  useEffect(() => {
    const d = actionFetcher.data;
    if (!d || actionFetcher.state !== "idle") return;
    if (d.error) {
      setNotice({ tone: "critical", title: d.error });
      return;
    }
    if (d.intent === "save")
      setNotice({ tone: "success", title: "Settings saved." });
    if (d.intent === "preview") {
      setPreview(d);
      setSelected(d.rows.filter((r) => !r.unchanged).map((r) => r.variantId));
      setTab(0);
      setConfirming(false);
      setNotice(null);
    }
    if (d.intent === "apply" || d.intent === "undo") {
      const verb = d.intent === "apply" ? "Updated" : "Restored";
      setNotice({
        tone: d.errors?.length ? "warning" : "success",
        title: `${verb} ${d.updatedCount} variant price${d.updatedCount === 1 ? "" : "s"}.`,
        errors: d.errors,
      });
      if (d.runs) setRuns(d.runs);
      setPreview(null);
      setConfirming(false);
    }
  }, [actionFetcher.data, actionFetcher.state]);

  const prices = useMemo(() => karatPrices(live, settings), [live, settings]);
  const busy = actionFetcher.state !== "idle";
  const busyIntent = busy ? lastIntent.current : null;
  const trend =
    live.usdPerOunce &&
    firstSpot.current &&
    Math.abs(live.usdPerOunce - firstSpot.current) >= 0.01
      ? live.usdPerOunce - firstSpot.current
      : 0;

  const submit = useCallback(
    (payload) => {
      lastIntent.current = payload.intent;
      actionFetcher.submit(JSON.stringify(payload), {
        method: "post",
        encType: "application/json",
      });
    },
    [actionFetcher],
  );

  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));
  const setMaking = (k, origin, value) =>
    setSettings((s) => ({
      ...s,
      making: { ...s.making, [k]: { ...s.making[k], [origin]: value } },
    }));
  const setOverride = (k, value) =>
    setSettings((s) => ({
      ...s,
      karatOverrides: { ...s.karatOverrides, [k]: value },
    }));
  const toggleKarat = (k, on) =>
    setSettings((s) => ({
      ...s,
      includeKarats: on
        ? [...new Set([...s.includeKarats, k])]
        : s.includeKarats.filter((x) => x !== k),
    }));

  const selectedRows = preview
    ? preview.rows.filter((r) => selected.includes(r.variantId))
    : [];
  const flaggedSelected = selectedRows.filter((r) => r.flagged).length;
  const latestUndoable = runs.find(
    (r) => r.kind === "apply" && !r.undone && r.updatedCount > 0,
  );

  return (
    <Page
      title="Gold Price Editor"
      subtitle="Keep your jewelry prices in sync with the global gold price"
      primaryAction={{
        content: "Preview new prices",
        onAction: () => submit({ intent: "preview", settings }),
        loading: busyIntent === "preview",
        disabled: busy,
      }}
    >
      <TitleBar title="Gold Price Editor" />
      <style>{STYLES}</style>

      <BlockStack gap="500">
        <LiveHero
          live={live}
          gram24={prices.gram24}
          usdEgp={prices.usdEgp}
          now={now}
          trend={trend}
          onRefresh={() => liveLoad("/app/gold-price")}
          refreshing={liveFetcher.state === "loading"}
        />

        {!live.ok && (
          <Banner tone="warning" title="Live price unavailable">
            <p>
              We couldn&apos;t reach the gold price service (
              {live.gold.error || live.fx.error || "unknown error"}). You can
              still update prices by entering a manual price per gram below.
            </p>
          </Banner>
        )}

        <KaratCards prices={prices} settings={settings} />

        {notice && (
          <Banner
            tone={notice.tone}
            title={notice.title}
            onDismiss={() => setNotice(null)}
          >
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
        )}

        {preview && (
          <Card padding="0">
            <Box padding="400">
              <BlockStack gap="400">
                <InlineStack
                  align="space-between"
                  blockAlign="center"
                  gap="300"
                >
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      Price preview
                    </Text>
                    <Text as="p" tone="subdued">
                      Based on 24k at {egp.format(preview.snapshot.gram24)} / g
                      · {formatDate(preview.snapshot.at)} ·{" "}
                      {preview.productCount} products scanned
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    <Button onClick={() => setPreview(null)} disabled={busy}>
                      Discard
                    </Button>
                    <Button
                      variant="primary"
                      tone={flaggedSelected ? "critical" : undefined}
                      disabled={!selectedRows.length || busy}
                      onClick={() => setConfirming(true)}
                    >
                      {`Apply ${selectedRows.length} price${selectedRows.length === 1 ? "" : "s"}`}
                    </Button>
                  </InlineStack>
                </InlineStack>

                <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
                  <Stat
                    label="Will change"
                    value={preview.rows.filter((r) => !r.unchanged).length}
                  />
                  <Stat
                    label="Already correct"
                    value={preview.rows.filter((r) => r.unchanged).length}
                  />
                  <Stat
                    label={`Change over ${settings.warnChangePct}%`}
                    value={preview.rows.filter((r) => r.flagged).length}
                    tone={
                      preview.rows.some((r) => r.flagged)
                        ? "critical"
                        : undefined
                    }
                  />
                  <Stat
                    label="Skipped"
                    value={preview.skipped.length}
                    tone={preview.skipped.length ? "caution" : undefined}
                  />
                </InlineGrid>

                {confirming && (
                  <Banner
                    tone={flaggedSelected ? "critical" : "info"}
                    title={`Update ${selectedRows.length} prices in your store now?`}
                    action={{
                      content: "Yes, apply prices",
                      loading: busyIntent === "apply",
                      onAction: () =>
                        submit({
                          intent: "apply",
                          snapshot: preview.snapshot,
                          changes: selectedRows.map((r) => ({
                            productId: r.productId,
                            variantId: r.variantId,
                            productTitle: r.productTitle,
                            variantTitle: r.variantTitle,
                            currentPrice: r.currentPrice,
                            newPrice: r.newPrice,
                          })),
                        }),
                    }}
                    secondaryAction={{
                      content: "Cancel",
                      onAction: () => setConfirming(false),
                    }}
                  >
                    <p>
                      {flaggedSelected
                        ? `${flaggedSelected} of them change by more than ${settings.warnChangePct}%. Check them first. `
                        : ""}
                      You can undo this run from the history card.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Box>
            <Tabs
              tabs={[
                { id: "update", content: `To update (${preview.rows.length})` },
                {
                  id: "skipped",
                  content: `Skipped (${preview.skipped.length})`,
                },
              ]}
              selected={tab}
              onSelect={setTab}
            />
            {tab === 0 ? (
              preview.rows.length ? (
                <PreviewTable
                  key={preview.snapshot.at}
                  rows={preview.rows}
                  selected={selected}
                  onSelect={setSelected}
                />
              ) : (
                <EmptyState heading="No matching products" image="">
                  <p>
                    Check the Skipped tab to see why products weren&apos;t
                    matched.
                  </p>
                </EmptyState>
              )
            ) : (
              <SkippedTable skipped={preview.skipped} />
            )}
          </Card>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Gold price
                    </Text>
                    <Text as="p" tone="subdued">
                      Prices come from the global spot price, converted to EGP
                      per gram. Leave a karat empty to use the live price, or
                      type a price to fix it manually.
                    </Text>
                  </BlockStack>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <TextField
                      label="Market premium"
                      type="number"
                      suffix="%"
                      value={String(settings.premiumPct)}
                      onChange={(v) => set("premiumPct", v)}
                      helpText="Added to the spot price to match the local market. Can be negative."
                      autoComplete="off"
                    />
                    <TextField
                      label="USD → EGP rate"
                      type="number"
                      value={settings.usdEgpOverride}
                      onChange={(v) => set("usdEgpOverride", v)}
                      placeholder={
                        live.usdEgp
                          ? `Live: ${num.format(live.usdEgp)}`
                          : "Enter a rate"
                      }
                      helpText="Leave empty to use the live rate."
                      autoComplete="off"
                    />
                  </InlineGrid>
                  <Divider />
                  <div className="gpe-scroll">
                    <table className="gpe-matrix">
                      <thead>
                        <tr>
                          <th>Karat</th>
                          <th>Update</th>
                          <th>Price / g (empty = live)</th>
                          <th>Workmanship / g · local</th>
                          <th>Workmanship / g · imported</th>
                        </tr>
                      </thead>
                      <tbody>
                        {KARATS.map((k) => (
                          <tr key={k}>
                            <td>
                              <Text as="span" fontWeight="semibold">
                                {k}k
                              </Text>
                            </td>
                            <td>
                              <Checkbox
                                label={`Update ${k}k products`}
                                labelHidden
                                checked={settings.includeKarats.includes(k)}
                                onChange={(on) => toggleKarat(k, on)}
                              />
                            </td>
                            <td>
                              <TextField
                                label={`${k}k price per gram`}
                                labelHidden
                                type="number"
                                value={settings.karatOverrides[k]}
                                placeholder={
                                  prices.gram24 > 0
                                    ? num.format(
                                        Math.round(
                                          (prices.gram24 * Number(k)) / 24,
                                        ),
                                      )
                                    : "Manual"
                                }
                                onChange={(v) => setOverride(k, v)}
                                autoComplete="off"
                              />
                            </td>
                            <td>
                              <TextField
                                label={`${k}k local workmanship`}
                                labelHidden
                                type="number"
                                value={String(settings.making[k].local)}
                                onChange={(v) => setMaking(k, "local", v)}
                                autoComplete="off"
                              />
                            </td>
                            <td>
                              <TextField
                                label={`${k}k imported workmanship`}
                                labelHidden
                                type="number"
                                value={String(settings.making[k].imported)}
                                onChange={(v) => setMaking(k, "imported", v)}
                                autoComplete="off"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">
                    A product metafield named <code>making_charge</code>{" "}
                    overrides the workmanship for that product.
                  </Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Rules
                  </Text>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <TextField
                      label="Discount per piece"
                      type="number"
                      prefix="EGP"
                      value={String(settings.discountPerPiece)}
                      onChange={(v) => set("discountPerPiece", v)}
                      helpText="Taken off the final price of each item."
                      autoComplete="off"
                    />
                    <Select
                      label="Round prices to"
                      options={[
                        { label: "No rounding", value: "0.01" },
                        { label: "Nearest 1 EGP", value: "1" },
                        { label: "Nearest 5 EGP", value: "5" },
                        { label: "Nearest 10 EGP", value: "10" },
                        { label: "Nearest 50 EGP", value: "50" },
                        { label: "Nearest 100 EGP", value: "100" },
                      ]}
                      value={settings.rounding}
                      onChange={(v) => set("rounding", v)}
                    />
                    <Select
                      label="Products with no origin"
                      options={[
                        { label: "Skip them", value: "skip" },
                        { label: "Treat as local", value: "local" },
                        { label: "Treat as imported", value: "imported" },
                      ]}
                      value={settings.unknownOrigin}
                      onChange={(v) => set("unknownOrigin", v)}
                    />
                    <TextField
                      label="Flag changes bigger than"
                      type="number"
                      suffix="%"
                      value={String(settings.warnChangePct)}
                      onChange={(v) => set("warnChangePct", v)}
                      autoComplete="off"
                    />
                  </InlineGrid>
                  <InlineStack align="end" gap="200">
                    <Button
                      onClick={() => submit({ intent: "save", settings })}
                      loading={busyIntent === "save"}
                      disabled={busy}
                    >
                      Save settings
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => submit({ intent: "preview", settings })}
                      loading={busyIntent === "preview"}
                      disabled={busy}
                    >
                      Preview new prices
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Price formula
                  </Text>
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <Text as="p" variant="bodySm">
                      (karat price per gram + workmanship per gram) × weight −
                      discount, then rounded.
                    </Text>
                  </Box>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Karat price = 24k price × karat ÷ 24. 24k price = spot
                    USD/oz ÷ 31.1035 × USD→EGP × (1 + premium).
                  </Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    History
                  </Text>
                  {runs.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No price updates yet.
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      {runs.map((r) => (
                        <InlineStack
                          key={r.id}
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                          gap="200"
                        >
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="semibold">
                              {r.kind === "undo" ? "Undo" : "Update"} ·{" "}
                              {r.updatedCount} prices
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {formatDate(r.createdAt)}
                              {r.gram24
                                ? ` · 24k ${egp0.format(r.gram24)}`
                                : ""}
                              {r.failedCount
                                ? ` · ${r.failedCount} failed`
                                : ""}
                            </Text>
                          </BlockStack>
                          {r.undone ? (
                            <Badge>Undone</Badge>
                          ) : latestUndoable && latestUndoable.id === r.id ? (
                            <Button
                              size="slim"
                              onClick={() =>
                                submit({ intent: "undo", runId: r.id })
                              }
                              loading={busyIntent === "undo"}
                              disabled={busy}
                            >
                              Undo
                            </Button>
                          ) : null}
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      How products are matched
                    </Text>
                    <Button
                      variant="plain"
                      onClick={() => setHelpOpen((o) => !o)}
                    >
                      {helpOpen ? "Hide" : "Show"}
                    </Button>
                  </InlineStack>
                  <Collapsible open={helpOpen} id="gpe-help">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm">
                        <strong>Karat</strong>: metafield <code>karat</code>,
                        then the title, tags, product type or SKU (e.g. “21k”,
                        “21 karat”, “عيار 21”).
                      </Text>
                      <Text as="p" variant="bodySm">
                        <strong>Origin</strong>: metafield <code>origin</code>,
                        then title, tags or product type (“local”, “محلي”,
                        “imported”, “مستورد”).
                      </Text>
                      <Text as="p" variant="bodySm">
                        <strong>Weight (grams)</strong>, first match wins:
                        metafield <code>metal_weight</code>, variant title
                        (“5.5g”), SKU (the last number, e.g. GLD-21K-LOC-
                        <strong>5.5</strong>), product title (“5 جرام”), tags,
                        then the variant&apos;s shipping weight.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        For rings with different sizes, put each size&apos;s
                        weight in its SKU or variant title rather than in the
                        product metafield.
                      </Text>
                    </BlockStack>
                  </Collapsible>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
      <Box paddingBlockEnd="800" />
    </Page>
  );
}

function Stat({ label, value, tone }) {
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="headingLg" tone={tone}>
          {value}
        </Text>
      </BlockStack>
    </Box>
  );
}
