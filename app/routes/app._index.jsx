import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
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
import { FriendlyError } from "../components/FriendlyError";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice, recentRates } from "../lib/goldPrice.server";
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
} from "../lib/store.server";
import {
  ORIGIN_LABELS,
  PURITIES,
  purityLabel,
  buildPlan,
  karatPrices,
  normalizeSettings,
  priceWithFormula,
  toNumber,
} from "../lib/pricing";
import {
  TEMPLATE_BY_ID,
  VARIABLES,
  parseFormula,
  validateFormula,
} from "../lib/formula";

export const meta = () => [{ title: "Gold Price Editor" }];

// The page keeps its own state from each action's reply, so Remix doesn't need to
// reload every loader after a save, preview, apply or undo. Fewer requests also means
// fewer chances for a network blip to break the page.
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [shopInfo, settings, runs] = await Promise.all([
    fetchShopInfo(admin, session.shop),
    loadSettings(admin, session.shop),
    recentRuns(session.shop),
  ]);
  // Everything is priced in the store's Shopify currency. If Shopify can't be read
  // right now, show the last saved currency (price updates stay blocked until it can).
  const currency = shopInfo.currency || settings.currency || "USD";
  const [live, history] = await Promise.all([
    getLiveGoldPrice(currency),
    recentRates(14, currency),
  ]);
  return json({
    live,
    settings,
    runs,
    history,
    taxesIncluded: shopInfo.taxesIncluded,
    shop: {
      currency,
      currencyKnown: Boolean(shopInfo.currency),
      timeZone: shopInfo.timeZone || "UTC",
    },
  });
};

// Why a preview can't run, or null. Each reason is a clear message instead of
// pricing with a wrong currency or an old exchange rate.
async function currencyProblem(admin, shop, shopInfo) {
  if (!shopInfo.currency)
    return "We couldn't read your store currency from Shopify, so no prices were calculated. Please try again in a minute.";
  const stored = await loadSettings(admin, shop);
  if (stored.currency && stored.currency !== shopInfo.currency)
    return `Your saved amounts (making charges, fees, manual prices) are in ${stored.currency}, but your store currency is now ${shopInfo.currency}. Check them, then press Save settings to confirm they are in ${shopInfo.currency}.`;
  return null;
}

function rateProblem(currency, settings, live) {
  if (settings.usdEgpOverride || !live.fx.outdated) return null;
  return live.usdRate
    ? `The USD → ${currency} exchange rate is out of date (last updated ${live.fx.updatedAt ? new Date(live.fx.updatedAt).toUTCString() : "unknown"}), so no prices were calculated. Try again later, or enter a manual exchange rate under Metal prices.`
    : `The USD → ${currency} exchange rate is unavailable (${live.fx.error || "unknown error"}), so no prices were calculated. Try again later, or enter a manual exchange rate under Metal prices.`;
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json();
  const shop = session.shop;

  try {
    if (body.intent === "save") {
      const shopInfo = await fetchShopInfo(admin, shop);
      const settings = await saveSettings(
        admin,
        shop,
        body.settings,
        shopInfo.currency,
      );
      return json({ intent: "save", ok: true, settings });
    }

    if (body.intent === "preview") {
      const shopInfo = await fetchShopInfo(admin, shop);
      const blocked = await currencyProblem(admin, shop, shopInfo);
      if (blocked)
        return json({ intent: "preview", error: blocked }, { status: 409 });
      const settings = await saveSettings(
        admin,
        shop,
        body.settings,
        shopInfo.currency,
      );
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
              "The live gold price is unavailable right now. Try again in a minute, or enter manual prices per gram.",
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

// Money is always shown in the store's Shopify currency.
function moneyFormat(currency, digits) {
  const base = { style: "currency", currency, maximumFractionDigits: digits };
  try {
    return new Intl.NumberFormat("en-US", base);
  } catch {
    try {
      // Currencies with more decimals by default (e.g. KWD) need a lower minimum.
      return new Intl.NumberFormat("en-US", {
        ...base,
        minimumFractionDigits: 0,
      });
    } catch {
      const n = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
      });
      return { format: (v) => `${currency} ${n.format(v)}` };
    }
  }
}

function shopFormat({ currency = "EGP", timeZone = "Africa/Cairo" } = {}) {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  return {
    currency,
    money: moneyFormat(currency, 2),
    money0: moneyFormat(currency, 0),
    // Fixed (store) time zone so the server and the browser show the same time.
    formatDate: (iso) =>
      new Date(iso).toLocaleString("en-GB", {
        timeZone: tz,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
  };
}

const ShopContext = createContext(shopFormat());
const useShop = () => useContext(ShopContext);
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

// ---------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------

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
`;

function LiveHero({
  live,
  gram24,
  gramSilver,
  usdRate,
  now,
  trend,
  onRefresh,
  refreshing,
}) {
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
              {gram24 > 0 ? money.format(gram24) : "—"}
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
              {gramSilver > 0 ? money.format(gramSilver) : "—"}
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
              {usdRate ? num.format(usdRate) : "—"}
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

function KaratCards({ prices, settings }) {
  const { money0 } = useShop();
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
  return (
    <BlockStack gap="300">
      <InlineGrid columns={{ xs: 2, sm: 4, md: 7 }} gap="300">
        {PURITIES.filter((p) => p.metal === "gold").map(card)}
      </InlineGrid>
      <InlineGrid columns={{ xs: 2, sm: 4, md: 7 }} gap="300">
        {PURITIES.filter((p) => p.metal === "silver").map(card)}
      </InlineGrid>
    </BlockStack>
  );
}

function RateHistory({ history }) {
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

const activeFormulaOf = (settings) =>
  settings.formulas.find((f) => f.id === settings.activeFormulaId) ||
  settings.formulas[0];

function FormulaCard({ settings, setSettings, prices, taxesIncluded }) {
  const { money, currency } = useShop();
  const [newName, setNewName] = useState("");
  const formula =
    settings.formulas.find((f) => f.id === settings.activeFormulaId) ||
    settings.formulas[0];
  const template = TEMPLATE_BY_ID[formula.templateId];
  const check = validateFormula(formula.expression);
  const vatLocked = taxesIncluded === false;

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const setExpression = (expression) =>
    update({
      formulas: settings.formulas.map((f) =>
        f.id === formula.id ? { ...f, expression } : f,
      ),
    });
  const choose = (id) => {
    const t = TEMPLATE_BY_ID[id];
    setSettings((s) => ({
      ...s,
      activeFormulaId: id,
      vat: t?.suggestVatBasis ? { ...s.vat, basis: t.suggestVatBasis } : s.vat,
    }));
  };
  const saveAsNew = () => {
    const id = `custom-${Date.now().toString(36)}`;
    update({
      formulas: [
        ...settings.formulas,
        {
          id,
          name: newName.trim() || "My formula",
          expression: formula.expression,
        },
      ],
      activeFormulaId: id,
    });
    setNewName("");
  };
  const remove = () =>
    update({
      formulas: settings.formulas.filter((f) => f.id !== formula.id),
      activeFormulaId: "classic",
    });
  const setVat = (patch) => update({ vat: { ...settings.vat, ...patch } });

  // Live example: 21k (or the first priced purity), 5 g, local workmanship.
  const exampleKey = prices.byKarat["21"]?.price > 0 ? "21" : "24";
  const exampleVars = {
    metal_price: prices.byKarat[exampleKey]?.price || 0,
    weight: 5,
    making: settings.making[exampleKey]?.local || 0,
    making_pct: settings.makingPct,
    wastage_pct: settings.wastagePct,
    stone_cost: 0,
    fixed_fee: settings.fixedFee,
    profit_pct: settings.profitPct,
    discount: settings.discountPerPiece,
  };
  let example = null;
  let exampleError = null;
  if (check.ok && exampleVars.metal_price > 0) {
    try {
      example = priceWithFormula(
        parseFormula(formula.expression),
        exampleVars,
        settings,
        !vatLocked,
      );
    } catch (error) {
      exampleError = error.message;
    }
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Price formula
          </Text>
          <Text as="p" tone="subdued">
            Pick a ready-made formula or write your own with the building blocks
            below. Switching formulas keeps all your values.
          </Text>
        </BlockStack>

        <Select
          label="Formula"
          options={settings.formulas.map((f) => ({
            label: f.templateId ? f.name : `${f.name} (yours)`,
            value: f.id,
          }))}
          value={formula.id}
          onChange={choose}
        />
        {template && (
          <Text as="p" variant="bodySm" tone="subdued">
            {template.description}
          </Text>
        )}

        <TextField
          label="Formula (before VAT, then rounded)"
          value={formula.expression}
          onChange={setExpression}
          multiline={2}
          monospaced
          autoComplete="off"
          error={check.ok ? undefined : check.error}
        />
        <InlineStack gap="200" wrap>
          {VARIABLES.map((v) => (
            <Button
              key={v.name}
              size="slim"
              onClick={() =>
                setExpression(`${formula.expression.trimEnd()} ${v.name}`)
              }
              accessibilityLabel={`Insert ${v.label}`}
            >
              {v.name}
            </Button>
          ))}
        </InlineStack>

        <div className="gpe-scroll">
          <table className="gpe-matrix" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th>Building block</th>
                <th>Means</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {VARIABLES.map((v) => (
                <tr key={v.name}>
                  <td>
                    <code>{v.name}</code>
                  </td>
                  <td>{v.label}</td>
                  <td>{v.unit.replace("{currency}", currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <InlineStack gap="200" blockAlign="end" wrap>
          {template && formula.expression !== template.expression && (
            <Button onClick={() => setExpression(template.expression)}>
              Reset to original
            </Button>
          )}
          {!template && (
            <Button tone="critical" variant="plain" onClick={remove}>
              Delete this formula
            </Button>
          )}
          <div style={{ minWidth: 200 }}>
            <TextField
              label="Save a copy as"
              labelHidden
              placeholder="Name for a new formula"
              value={newName}
              onChange={setNewName}
              autoComplete="off"
              connectedRight={
                <Button onClick={saveAsNew} disabled={!check.ok}>
                  Save as new
                </Button>
              }
            />
          </div>
        </InlineStack>

        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          {exampleError ? (
            <Text as="p" tone="critical">
              Example failed: {exampleError}
            </Text>
          ) : example ? (
            <Text as="p" variant="bodySm">
              Example: {purityLabel(exampleKey)}, 5 g, local making charge →
              before VAT {money.format(example.preVat)}
              {example.vat > 0
                ? ` + VAT ${money.format(example.vat)}`
                : ""} = <strong>{money.format(example.price)}</strong>
            </Text>
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">
              The example appears when the formula is valid and a price is
              available.
            </Text>
          )}
        </Box>

        <Divider />
        <Text as="h3" variant="headingSm">
          Optional costs
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Shop-wide values. A product metafield with the same name (
          <code>wastage_pct</code>, <code>making_pct</code>,{" "}
          <code>fixed_fee</code>, <code>profit_pct</code>) overrides them for
          that product. Stone / diamond cost is set per product in a{" "}
          <code>stone_cost</code> metafield ({currency}, total per piece). Each
          cost is only used if your formula includes it.
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="Wastage"
            type="number"
            suffix="% of metal"
            value={String(settings.wastagePct)}
            onChange={(v) => update({ wastagePct: v })}
            autoComplete="off"
          />
          <TextField
            label="Making charge %"
            type="number"
            suffix="% of metal value"
            value={String(settings.makingPct)}
            onChange={(v) => update({ makingPct: v })}
            autoComplete="off"
          />
          <TextField
            label="Fixed fee"
            type="number"
            prefix={currency}
            suffix="per piece"
            value={String(settings.fixedFee)}
            onChange={(v) => update({ fixedFee: v })}
            autoComplete="off"
          />
          <TextField
            label="Profit"
            type="number"
            suffix="%"
            value={String(settings.profitPct)}
            onChange={(v) => update({ profitPct: v })}
            autoComplete="off"
          />
        </InlineGrid>

        <Divider />
        <Text as="h3" variant="headingSm">
          VAT
        </Text>
        {vatLocked ? (
          <Banner tone="info">
            <p>
              Your Shopify store adds tax at checkout (Settings → Taxes and
              duties → &quot;Include sales tax in product price&quot; is off).
              Adding VAT here too would charge it twice, so VAT is switched off
              in the app. Turn that Shopify setting on if your prices should
              include VAT.
            </p>
          </Banner>
        ) : taxesIncluded === null ? (
          <Banner tone="warning">
            <p>
              We couldn&apos;t read your Shopify tax setting. Only add VAT here
              if your Shopify prices include tax.
            </p>
          </Banner>
        ) : null}
        <Checkbox
          label="Add VAT to prices"
          checked={settings.vat.enabled && !vatLocked}
          disabled={vatLocked}
          onChange={(on) => setVat({ enabled: on })}
          helpText="Added after the formula, before rounding."
        />
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="VAT rate"
            type="number"
            suffix="%"
            value={String(settings.vat.pct)}
            onChange={(v) => setVat({ pct: v })}
            disabled={vatLocked || !settings.vat.enabled}
            autoComplete="off"
          />
          <Select
            label="VAT is charged on"
            options={[
              { label: "The total price", value: "total" },
              { label: "Workmanship only", value: "workmanship" },
            ]}
            value={settings.vat.basis}
            onChange={(v) => setVat({ basis: v })}
            disabled={vatLocked || !settings.vat.enabled}
            helpText="Workmanship = making charge per gram × weight, plus any making charge %."
          />
        </InlineGrid>
      </BlockStack>
    </Card>
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const data = useLoaderData();
  const shop = useMemo(() => shopFormat(data.shop), [data.shop]);
  const { money, money0, currency, formatDate } = shop;
  // The currency the saved amounts are in (empty for a store that never saved).
  const [savedCurrency, setSavedCurrency] = useState(data.settings.currency);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIntent, setBusyIntent] = useState(null);

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
  const busyRef = useRef(false);

  // Refresh the live price. A failed refresh (server waking up or restarting, Wi-Fi
  // drop) is ignored: the last price stays on screen and its "updated x ago" shows
  // it is getting old. Plain fetch, not a Remix fetcher, because a fetcher sends a
  // network error to the error screen and replaces the whole page.
  const refreshLive = useCallback(async () => {
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

  // Poll the live price every 30 seconds and tick the "updated x ago" clock.
  useEffect(() => {
    const poll = setInterval(refreshLive, 30000);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refreshLive]);

  // Handle action results.
  const handleResult = useCallback((d) => {
    if (d.error) {
      setNotice({ tone: "critical", title: d.error });
      return;
    }
    if (d.intent === "save") {
      setNotice({ tone: "success", title: "Settings saved." });
      if (d.settings?.currency) setSavedCurrency(d.settings.currency);
    }
    if (d.intent === "preview") {
      setPreview(d);
      setSelected(d.rows.filter((r) => !r.unchanged).map((r) => r.variantId));
      setTab(0);
      setConfirming(false);
      setNotice(null);
    }
    if (d.intent === "apply" || d.intent === "undo") {
      const verb = d.intent === "apply" ? "Updated" : "Restored";
      const skippedCount = d.skipped?.length || 0;
      setNotice({
        tone: d.errors?.length || skippedCount ? "warning" : "success",
        title:
          `${verb} ${d.updatedCount} variant price${d.updatedCount === 1 ? "" : "s"}.` +
          (skippedCount
            ? ` ${skippedCount} skipped because the price was changed in Shopify after the ${d.intent === "apply" ? "preview" : "update"}.`
            : ""),
        errors: [
          ...(d.errors || []),
          ...(d.skipped || []).map((s) => ({
            productId: s.variantId,
            productTitle: s.variantTitle
              ? `${s.productTitle} (${s.variantTitle})`
              : s.productTitle,
            message: s.reason,
          })),
        ],
      });
      if (d.runs) setRuns(d.runs);
      setPreview(null);
      setConfirming(false);
    }
  }, []);

  const prices = useMemo(() => karatPrices(live, settings), [live, settings]);
  const busy = busyIntent !== null;
  const trend =
    live.usdPerOunce &&
    firstSpot.current &&
    Math.abs(live.usdPerOunce - firstSpot.current) >= 0.01
      ? live.usdPerOunce - firstSpot.current
      : 0;

  // Send an action (save, preview, apply, undo) to this page's server action.
  // Plain fetch so that a network error shows a message and keeps the page and its
  // unsaved settings, instead of the full-page "Application Error".
  const submit = useCallback(
    async (payload) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyIntent(payload.intent);
      try {
        const res = await fetch("/app?index&_data=routes%2Fapp._index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (body && typeof body === "object" && (body.intent || body.error)) {
          handleResult(body);
        } else {
          handleResult({
            error: `The server could not finish this (error ${res.status}). Please try again.`,
          });
        }
      } catch (error) {
        console.warn("Action failed:", error);
        handleResult({
          error:
            payload.intent === "apply" || payload.intent === "undo"
              ? "Lost the connection to the app server. Some prices may or may not have changed: reload the page and check Recent updates before trying again."
              : "Lost the connection to the app server. It may be waking up: please wait a few seconds and try again.",
        });
      } finally {
        busyRef.current = false;
        setBusyIntent(null);
      }
    },
    [handleResult],
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

  const currencyMismatch =
    data.shop.currencyKnown && savedCurrency && savedCurrency !== currency;
  const rateOutdated =
    currency !== "USD" && live.fx.outdated && !settings.usdEgpOverride;

  return (
    <ShopContext.Provider value={shop}>
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
        {/* As raw HTML: React escapes ">" in style text on the server, which broke hydration. */}
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />

        <BlockStack gap="500">
          <LiveHero
            live={live}
            gram24={prices.gram24}
            gramSilver={prices.gramSilver}
            usdRate={prices.usdRate}
            now={now}
            trend={trend}
            onRefresh={refreshLive}
            refreshing={refreshing}
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

          {!data.shop.currencyKnown && (
            <Banner tone="critical" title="Store currency unknown">
              <p>
                We couldn&apos;t read your store currency from Shopify, so
                prices are shown in {currency} for now and price updates are
                paused. Reload the page in a minute.
              </p>
            </Banner>
          )}

          {currencyMismatch && (
            <Banner tone="critical" title="Your store currency has changed">
              <p>
                Your saved amounts (making charges, fees, discount, manual
                prices) were entered in {savedCurrency}, but your store now uses{" "}
                {currency}. Check every amount below, then press Save settings
                to confirm they are in {currency}. Price updates are paused
                until then.
              </p>
            </Banner>
          )}

          {live.ok && rateOutdated && (
            <Banner
              tone="critical"
              title={`USD → ${currency} rate is out of date`}
            >
              <p>
                The exchange rate was last updated{" "}
                {live.fx.updatedAt
                  ? formatDate(live.fx.updatedAt)
                  : "at an unknown time"}
                , so price updates are paused instead of using an old rate. This
                usually fixes itself within a day, or you can enter a manual
                exchange rate under Metal prices.
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
                        Based on 24k at {money.format(preview.snapshot.gram24)}{" "}
                        / g · {formatDate(preview.snapshot.at)} ·{" "}
                        {preview.productCount} products scanned
                      </Text>
                      {preview.vatBlocked && (
                        <Text as="p" variant="bodySm" tone="caution">
                          VAT was not added: your Shopify store adds tax at
                          checkout.
                        </Text>
                      )}
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
                            previewId: preview.previewId,
                            variantIds: selectedRows.map((r) => r.variantId),
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
                  {
                    id: "update",
                    content: `To update (${preview.rows.length})`,
                  },
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
                        Metal prices
                      </Text>
                      <Text as="p" tone="subdued">
                        Prices come from the global gold and silver spot prices,
                        converted to {currency} per gram. Leave a price empty to
                        use the live price, or type a price to fix it manually.
                      </Text>
                    </BlockStack>
                    <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                      <TextField
                        label="Gold market premium"
                        type="number"
                        suffix="%"
                        value={String(settings.premiumPct)}
                        onChange={(v) => set("premiumPct", v)}
                        helpText="Added to the spot price to match the local market. Can be negative."
                        autoComplete="off"
                      />
                      <TextField
                        label="Silver market premium"
                        type="number"
                        suffix="%"
                        value={String(settings.silverPremiumPct)}
                        onChange={(v) => set("silverPremiumPct", v)}
                        helpText="Same, for silver."
                        autoComplete="off"
                      />
                      {currency !== "USD" && (
                        <TextField
                          label={`USD → ${currency} rate`}
                          type="number"
                          value={settings.usdEgpOverride}
                          onChange={(v) => set("usdEgpOverride", v)}
                          placeholder={
                            live.usdRate
                              ? `Live: ${num.format(live.usdRate)}`
                              : "Enter a rate"
                          }
                          helpText="Leave empty to use the live rate."
                          autoComplete="off"
                        />
                      )}
                    </InlineGrid>
                    <Divider />
                    <div className="gpe-scroll">
                      <table className="gpe-matrix">
                        <thead>
                          <tr>
                            <th>Purity</th>
                            <th>Update</th>
                            <th>Price ({currency}/g, empty = live)</th>
                            <th>Workmanship ({currency}/g) · local</th>
                            <th>Workmanship ({currency}/g) · imported</th>
                          </tr>
                        </thead>
                        <tbody>
                          {PURITIES.map(({ key: k, label }) => (
                            <tr key={k}>
                              <td>
                                <Text as="span" fontWeight="semibold">
                                  {label}
                                </Text>
                              </td>
                              <td>
                                <Checkbox
                                  label={`Update ${label} products`}
                                  labelHidden
                                  checked={settings.includeKarats.includes(k)}
                                  onChange={(on) => toggleKarat(k, on)}
                                />
                              </td>
                              <td>
                                <TextField
                                  label={`${label} price per gram`}
                                  labelHidden
                                  type="number"
                                  value={settings.karatOverrides[k]}
                                  placeholder={
                                    prices.byKarat[k].livePrice > 0
                                      ? num.format(
                                          Math.round(
                                            prices.byKarat[k].livePrice * 100,
                                          ) / 100,
                                        )
                                      : "Manual"
                                  }
                                  onChange={(v) => setOverride(k, v)}
                                  autoComplete="off"
                                />
                              </td>
                              <td>
                                <TextField
                                  label={`${label} local workmanship`}
                                  labelHidden
                                  type="number"
                                  value={String(settings.making[k].local)}
                                  onChange={(v) => setMaking(k, "local", v)}
                                  autoComplete="off"
                                />
                              </td>
                              <td>
                                <TextField
                                  label={`${label} imported workmanship`}
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

                <FormulaCard
                  settings={settings}
                  setSettings={setSettings}
                  prices={prices}
                  taxesIncluded={data.taxesIncluded}
                />

                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Rules
                    </Text>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <TextField
                        label="Discount per piece"
                        type="number"
                        prefix={currency}
                        value={String(settings.discountPerPiece)}
                        onChange={(v) => set("discountPerPiece", v)}
                        helpText="Taken off the final price of each item."
                        autoComplete="off"
                      />
                      <Select
                        label="Round prices to"
                        options={[
                          { label: "No rounding", value: "0.01" },
                          { label: `Nearest 1 ${currency}`, value: "1" },
                          { label: `Nearest 5 ${currency}`, value: "5" },
                          { label: `Nearest 10 ${currency}`, value: "10" },
                          { label: `Nearest 50 ${currency}`, value: "50" },
                          { label: `Nearest 100 ${currency}`, value: "100" },
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
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          {activeFormulaOf(settings).name}
                        </Text>
                        <Text as="p" variant="bodySm">
                          <code>{activeFormulaOf(settings).expression}</code>
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {settings.vat.enabled && data.taxesIncluded !== false
                            ? `+ VAT ${settings.vat.pct}% on ${settings.vat.basis === "workmanship" ? "workmanship" : "the total"}, then rounded.`
                            : "Then rounded. No VAT."}
                        </Text>
                      </BlockStack>
                    </Box>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Karat price = 24k price × karat ÷ 24. 24k price = spot
                      USD/oz ÷ 31.1035 × USD→{currency} × (1 + premium). Silver
                      works the same way: 925 = 92.5% of the fine silver (999)
                      price.
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
                                  ? ` · 24k ${money0.format(r.gram24)}`
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
                    <Text as="h2" variant="headingMd">
                      Market prices, last 14 days
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Pure metal per gram in {currency}, before your premium.
                    </Text>
                    <RateHistory history={data.history} />
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
                          <strong>Silver</strong>: a product is silver when its{" "}
                          <code>metal</code> metafield, title, tags, type or SKU
                          says “silver”, “sterling” or “فضة”, or carries the 925
                          hallmark. The purity (925 or 999) is read from the{" "}
                          <code>purity</code> metafield, then the same places.
                        </Text>
                        <Text as="p" variant="bodySm">
                          <strong>Origin</strong>: metafield <code>origin</code>
                          , then title, tags or product type (“local”, “محلي”,
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
    </ShopContext.Provider>
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

// Shown instead of Remix's bare "Application Error" if this page ever crashes.
export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
