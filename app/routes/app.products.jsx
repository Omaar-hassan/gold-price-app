import { useCallback, useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Modal,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { FriendlyError } from "../components/FriendlyError";
import { authenticate } from "../shopify.server";
import { getLiveGoldPrice } from "../lib/goldPrice.server";
import {
  fetchAllProducts,
  fetchShopInfo,
  loadSettings,
  saveProductFix,
} from "../lib/store.server";
import {
  ORIGIN_LABELS,
  PURITIES,
  PURITY_BY_KEY,
  karatPrices,
  productOverview,
  purityLabel,
} from "../lib/pricing";
import { shopFormat } from "../lib/format";

export const meta = () => [{ title: "Products · Gold Price Editor" }];

// Read-only overview of every variant: what the app detected and whether it would
// be priced. It never changes prices; that stays Preview -> Apply on the dashboard.
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [shopInfo, settings, products] = await Promise.all([
    fetchShopInfo(admin, session.shop),
    loadSettings(admin, session.shop),
    fetchAllProducts(admin),
  ]);
  const currency = shopInfo.currency || settings.currency || "USD";
  const live = await getLiveGoldPrice(currency);
  const prices = karatPrices(live, settings);
  const overview = productOverview(products, settings, prices, {
    taxesIncluded: shopInfo.taxesIncluded,
  });
  return json({
    ...overview,
    liveOk: live.ok,
    shop: { currency, timeZone: shopInfo.timeZone || "UTC" },
  });
};

// Save the Fix form: metal + purity + origin on the product, weight on the variant,
// as gold_price metafields. Never writes prices.
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, { status: 400 });
  }
  const gid = (v, type) =>
    new RegExp(`^gid://shopify/${type}/\\d+$`).test(String(v || ""));
  if (!gid(body.productId, "Product") || !gid(body.variantId, "ProductVariant"))
    return json({ error: "Unknown product." }, { status: 400 });

  const fix = {};
  if (body.karat) {
    const purity = PURITY_BY_KEY[body.karat];
    if (!purity)
      return json({ error: "Pick a karat or purity." }, { status: 400 });
    fix.metal = purity.metal;
    fix.karat = purity.metal === "gold" ? `${purity.key}K` : purity.key;
  }
  if (body.origin) {
    if (!ORIGIN_LABELS[body.origin])
      return json({ error: "Pick Local or Imported." }, { status: 400 });
    fix.origin = body.origin;
  }
  if (body.weight !== undefined && body.weight !== "") {
    const w = Number(String(body.weight).replace(",", "."));
    if (!(w > 0 && w <= 100000))
      return json(
        { error: "Weight must be a number of grams above 0." },
        { status: 400 },
      );
    fix.weight = Math.round(w * 1000) / 1000;
  }
  if (!Object.keys(fix).length)
    return json({ error: "Nothing to save." }, { status: 400 });

  try {
    await saveProductFix(admin, body.productId, body.variantId, fix);
    return json({ ok: true });
  } catch (error) {
    console.error("[gold-price] product fix failed:", error);
    return json(
      { error: "Shopify did not save it: " + error.message },
      { status: 502 },
    );
  }
};

const TABS = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "skipped", label: "Skipped" },
  { id: "excluded", label: "Switched off" },
];

const STATUS_BADGE = {
  ready: { tone: "success", label: "Ready" },
  skipped: { tone: "warning", label: "Skipped" },
  excluded: { tone: undefined, label: "Switched off" },
};

const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

// "gid://shopify/Product/123" -> "shopify:admin/products/123" (opens in Shopify admin).
const adminLink = (gid) =>
  `shopify:admin/products/${String(gid).split("/").pop()}`;

function Detected({ value, source, missing }) {
  if (!value)
    return (
      <Text as="span" tone="critical">
        {missing}
      </Text>
    );
  return (
    <BlockStack gap="050">
      <span>{value}</span>
      {source && (
        <Text as="span" variant="bodySm" tone="subdued">
          from {source}
        </Text>
      )}
    </BlockStack>
  );
}

const PURITY_OPTIONS = [
  { label: "Choose…", value: "" },
  ...PURITIES.map((p) => ({
    label: `${p.metal === "gold" ? "Gold" : "Silver"} ${p.label}`,
    value: p.key,
  })),
];
const ORIGIN_OPTIONS = [
  { label: "Choose…", value: "" },
  ...Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ label, value })),
];

// Small form to set what the app couldn't detect. Pre-filled with what it found.
function FixModal({ item, onClose, onSaved }) {
  const [karat, setKarat] = useState(item.karat || "");
  const [origin, setOrigin] = useState(item.origin || "");
  const [weight, setWeight] = useState(item.weight ? String(item.weight) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = { productId: item.productId, variantId: item.variantId };
    // Only send what changed, so values found elsewhere are not copied needlessly.
    if (karat && karat !== item.karat) payload.karat = karat;
    if (origin && (origin !== item.origin || item.originGuessed))
      payload.origin = origin;
    if (weight && Number(weight) !== item.weight) payload.weight = weight;
    if (Object.keys(payload).length === 2) {
      onClose();
      return;
    }
    try {
      const res = await fetch("/app/products?_data=routes%2Fapp.products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error || `Could not save (error ${res.status}).`);
        setSaving(false);
        return;
      }
      await onSaved(item);
    } catch {
      setError(
        "Lost the connection to the app server. Please try again in a few seconds.",
      );
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Fix: ${item.productTitle}${item.variantTitle ? ` (${item.variantTitle})` : ""}`}
      primaryAction={{ content: "Save", onAction: save, loading: saving }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          )}
          <Select
            label="Metal and karat / purity"
            options={PURITY_OPTIONS}
            value={karat}
            onChange={setKarat}
            helpText="Applies to every variant of this product."
          />
          <Select
            label="Origin"
            options={ORIGIN_OPTIONS}
            value={origin}
            onChange={setOrigin}
            helpText="Picks the local or imported making charge. Applies to every variant."
          />
          <TextField
            label="Metal weight"
            type="number"
            suffix="g"
            value={weight}
            onChange={setWeight}
            helpText="For this variant only."
            autoComplete="off"
          />
          <Text as="p" variant="bodySm" tone="subdued">
            Saved on the product in Shopify (metafields{" "}
            <code>gold_price.*</code>
            ), so it stays if you reinstall. This does not change the price:
            prices only change with Preview and Apply on the dashboard.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function Products() {
  const loaded = useLoaderData();
  const [data, setData] = useState(loaded);
  const { money } = useMemo(() => shopFormat(data.shop), [data.shop]);
  const [tab, setTab] = useState(loaded.counts.skipped ? 2 : 0);
  const [query, setQuery] = useState("");
  const [fixing, setFixing] = useState(null);
  const [notice, setNotice] = useState(null);

  // After a fix, reload the list so the new status shows. Plain fetch (see the
  // dashboard): a network error keeps the page instead of the error screen.
  const onSaved = useCallback(async (item) => {
    setFixing(null);
    try {
      const res = await fetch("/app/products?_data=routes%2Fapp.products");
      const next = res.ok ? await res.json() : null;
      if (next?.items) {
        setData(next);
        const now = next.items.find((i) => i.variantId === item.variantId);
        setNotice(
          now?.status === "ready"
            ? {
                tone: "success",
                text: `Saved. ${item.productTitle} is ready to be priced.`,
              }
            : {
                tone: "warning",
                text: `Saved. ${item.productTitle}: ${now?.reason || "still skipped"}.`,
              },
        );
        return;
      }
    } catch {
      // fall through
    }
    setNotice({
      tone: "success",
      text: "Saved. Reload the page to see the new status.",
    });
  }, []);

  const status = TABS[tab].id;
  const q = query.trim().toLowerCase();
  const items = data.items.filter(
    (i) =>
      (status === "all" || i.status === status) &&
      (!q ||
        [i.productTitle, i.variantTitle, i.sku]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );

  return (
    <Page
      title="Products"
      subtitle="What the app found on each product, and whether it will be priced"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Products" />
      <BlockStack gap="400">
        {data.formulaError && (
          <Banner tone="critical" title="Your formula has an error">
            <p>{data.formulaError}</p>
          </Banner>
        )}
        {!data.liveOk && (
          <Banner tone="warning" title="Live price unavailable">
            <p>
              New prices can&apos;t be calculated right now, so products using
              the live price show as skipped. Detection of karat, origin and
              weight below is still correct.
            </p>
          </Banner>
        )}

        {notice && (
          <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
            <p>{notice.text}</p>
          </Banner>
        )}

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({
              id: t.id,
              content: `${t.label} (${data.counts[t.id]})`,
            }))}
            selected={tab}
            onSelect={setTab}
          />
          <Box padding="300">
            <TextField
              label="Search products"
              labelHidden
              placeholder="Search by product, variant or SKU"
              value={query}
              onChange={setQuery}
              clearButton
              onClearButtonClick={() => setQuery("")}
              autoComplete="off"
            />
          </Box>
          {items.length ? (
            <IndexTable
              resourceName={{ singular: "variant", plural: "variants" }}
              itemCount={items.length}
              selectable={false}
              headings={[
                { title: "Product" },
                { title: "Status" },
                { title: "Metal / purity" },
                { title: "Origin" },
                { title: "Weight" },
                { title: "Current", alignment: "end" },
                { title: "New", alignment: "end" },
                { title: "" },
              ]}
            >
              {items.map((i, index) => (
                <IndexTable.Row
                  id={i.variantId}
                  key={i.variantId}
                  position={index}
                >
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Thumbnail
                        size="small"
                        alt=""
                        source={i.image || BLANK}
                      />
                      <BlockStack gap="050">
                        <a
                          href={adminLink(i.productId)}
                          target="_top"
                          style={{ color: "inherit", fontWeight: 600 }}
                        >
                          {i.productTitle}
                        </a>
                        {(i.variantTitle || i.sku) && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {[i.variantTitle, i.sku]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        )}
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="100">
                      <span>
                        <Badge tone={STATUS_BADGE[i.status].tone}>
                          {STATUS_BADGE[i.status].label}
                        </Badge>
                      </span>
                      {i.reason && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {i.reason}
                        </Text>
                      )}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Detected
                      value={i.karat ? purityLabel(i.karat) : null}
                      source={i.karatSource}
                      missing={
                        i.metal === "silver"
                          ? "Purity not found"
                          : "Karat not found"
                      }
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Detected
                      value={ORIGIN_LABELS[i.origin]}
                      source={i.originGuessed ? "your default" : i.originSource}
                      missing="Not found"
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Detected
                      value={i.weight ? `${num.format(i.weight)} g` : null}
                      source={i.weightSource}
                      missing="Not found"
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end" numeric tone="subdued">
                      {money.format(i.currentPrice)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text
                      as="span"
                      alignment="end"
                      numeric
                      fontWeight="semibold"
                    >
                      {i.newPrice ? money.format(i.newPrice) : "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button
                      size="slim"
                      variant={i.status === "skipped" ? "primary" : undefined}
                      onClick={() => setFixing(i)}
                    >
                      {i.status === "skipped" ? "Fix" : "Edit"}
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          ) : (
            <Box padding="400">
              <Text as="p" tone="subdued">
                {data.counts.all
                  ? "No products match."
                  : "Your store has no products yet."}
              </Text>
            </Box>
          )}
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">
              How products are recognised
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Karat or purity, origin and weight are read from the product
              metafields first (keys like <code>karat</code>,{" "}
              <code>origin</code>, <code>metal_weight</code>), then the title,
              tags, product type, variant title or SKU (for example
              &quot;21K&quot;, &quot;Local&quot;, &quot;5.5g&quot;), and finally
              the shipping weight. Use Fix to set what is missing, or click a
              product name to edit it in Shopify. New prices here are an
              estimate; prices only change when you press Preview and Apply on
              the dashboard.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
      <Box paddingBlockEnd="800" />
      {fixing && (
        <FixModal
          item={fixing}
          onClose={() => setFixing(null)}
          onSaved={onSaved}
        />
      )}
    </Page>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
