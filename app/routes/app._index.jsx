import { useMemo } from "react";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Text,
} from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  AutoRunBanner,
  autoStatus,
  KaratCards,
  LiveHero,
  ShopAlerts,
  Sparkline,
  Stat,
  runLabel,
  timeAgo,
  TimerLine,
  useLivePrice,
  useShop,
} from "../components/ui";
import { activeFormulaOf } from "../components/pricing";
import { loadContext } from "../lib/pages.server";
import { autoSummary } from "../lib/auto.server";
import { recentRates } from "../lib/goldPrice.server";
import { fetchAllProducts, recentRuns } from "../lib/store.server";
import { karatPrices, productOverview } from "../lib/pricing";

export const meta = () => [{ title: "Gold Price Editor" }];

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  const [runs, history, auto, totals] = await Promise.all([
    recentRuns(ctx.shopDomain, 5),
    recentRates(14, ctx.currency),
    autoSummary(ctx.shopDomain, ctx.settings, ctx.shopInfo.timeZone),
    // Real product totals. If Shopify can't be read, the dashboard still loads.
    fetchAllProducts(ctx.admin)
      .then((products) => {
        const prices = karatPrices(ctx.live, ctx.settings);
        const o = productOverview(products, ctx.settings, prices, {
          taxesIncluded: ctx.shopInfo.taxesIncluded,
        });
        const metals = { gold: 0, silver: 0 };
        for (const i of o.items) if (i.karat) metals[i.metal]++;
        return {
          products: products.length,
          ...o.counts,
          metals,
          toChange: o.items.filter((i) => i.status === "ready" && !i.unchanged)
            .length,
        };
      })
      .catch((error) => {
        console.error("[gold-price] dashboard totals failed:", error.message);
        return null;
      }),
  ]);
  return json({ ...ctx.common, runs, history, auto, totals });
};

function pctChange(history) {
  const gold = (history || []).map((h) => h.gold).filter((v) => v > 0);
  if (gold.length < 2) return null;
  const newest = gold[0];
  const oldest = gold[gold.length - 1];
  return ((newest - oldest) / oldest) * 100;
}

function RecentUpdates({ runs, now }) {
  const { formatDate } = useShop();
  if (!runs.length)
    return (
      <Text as="p" tone="subdued">
        No price updates yet.
      </Text>
    );
  return (
    <BlockStack gap="300">
      {runs.map((r) => (
        <InlineStack
          key={r.id}
          align="space-between"
          blockAlign="center"
          gap="200"
          wrap={false}
        >
          <BlockStack gap="050">
            <Text as="span" fontWeight="semibold">
              {runLabel(r.kind)} · {r.updatedCount} price
              {r.updatedCount === 1 ? "" : "s"}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {formatDate(r.createdAt)} · {timeAgo(r.createdAt, now)}
            </Text>
          </BlockStack>
          {r.undone ? (
            <Badge>Undone</Badge>
          ) : r.failedCount ? (
            <Badge tone="critical">{`${r.failedCount} failed`}</Badge>
          ) : null}
        </InlineStack>
      ))}
    </BlockStack>
  );
}

function AutoCard({ auto }) {
  const { formatDate } = useShop();
  const latest = auto.latest;
  const status = latest && autoStatus(latest);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Automatic updates
          </Text>
          <Badge tone={auto.enabled ? "success" : undefined}>
            {auto.enabled ? "On" : "Off"}
          </Badge>
        </InlineStack>
        {auto.enabled ? (
          <Text as="p" variant="bodySm">
            {auto.next
              ? `Next update: ${formatDate(auto.next)}`
              : "No times set."}
          </Text>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            Prices change only when you press Apply.
          </Text>
        )}
        {latest && (
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <Text as="span" variant="bodySm" tone="subdued">
              Last: {formatDate(latest.slot)}
              {latest.updatedCount
                ? ` · ${latest.updatedCount} price${latest.updatedCount === 1 ? "" : "s"}`
                : ""}
            </Text>
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
          </InlineStack>
        )}
        {auto.enabled && <TimerLine auto={auto} />}
        <Link to="/app/settings">
          {auto.enabled ? "Change times" : "Turn on in Settings"}
        </Link>
      </BlockStack>
    </Card>
  );
}

export default function Dashboard() {
  const data = useLoaderData();
  const { settings, totals, runs } = data;
  const { live, refresh, refreshing, now, trend } = useLivePrice(data.live);
  const prices = useMemo(() => karatPrices(live, settings), [live, settings]);
  const lastRun = runs.find((r) => r.kind === "apply" || r.kind === "auto");
  const change = pctChange(data.history);
  const formula = activeFormulaOf(settings);

  return (
    <AppPage
      shop={data.shop}
      title="Dashboard"
      subtitle="Your jewelry prices, in sync with the global gold price"
      primaryAction={{ content: "Update prices", url: "/app/updates" }}
    >
      <BlockStack gap="400">
        <LiveHero
          live={live}
          prices={prices}
          now={now}
          trend={trend}
          onRefresh={refresh}
          refreshing={refreshing}
        />
        <ShopAlerts live={live} settings={settings} shop={data.shop} />
        <AutoRunBanner
          autoRun={data.auto.latest}
          lastManualAt={data.auto.lastManualAt}
          reviewAction={{ content: "Go to Price Updates", url: "/app/updates" }}
        />

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <Link to="/app/products" className="gpe-stat-link">
            <Stat
              label="Products ready to price"
              value={totals ? totals.ready : "—"}
              help={
                totals
                  ? `${totals.metals.gold} gold · ${totals.metals.silver} silver`
                  : "Could not load products"
              }
            />
          </Link>
          <Link to="/app/products" className="gpe-stat-link">
            <Stat
              label="Need attention"
              value={totals ? totals.skipped : "—"}
              tone={totals?.skipped ? "caution" : undefined}
              help={totals?.skipped ? "Skipped · tap to fix" : "All matched"}
            />
          </Link>
          <Link to="/app/history" className="gpe-stat-link">
            <Stat
              label="Last update"
              value={
                lastRun
                  ? `${lastRun.updatedCount} price${lastRun.updatedCount === 1 ? "" : "s"}`
                  : "Never"
              }
              help={
                lastRun
                  ? `${timeAgo(lastRun.createdAt, now)}${lastRun.undone ? " · undone" : ""}`
                  : "No updates yet"
              }
            />
          </Link>
          <Link to="/app/rates" className="gpe-stat-link">
            <Stat
              label="24k, last 14 days"
              value={
                change === null
                  ? "—"
                  : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`
              }
              tone={
                change === null
                  ? undefined
                  : change >= 0
                    ? "success"
                    : "critical"
              }
              help={
                change === null ? "Needs 2 days of prices" : "Market change"
              }
            />
          </Link>
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack
                  align="space-between"
                  blockAlign="center"
                  gap="200"
                >
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Today&apos;s prices per gram
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      The karats you update · formula: {formula.name}
                    </Text>
                  </BlockStack>
                  <Link to="/app/rates">Metal Rates</Link>
                </InlineStack>
                <KaratCards prices={prices} settings={settings} onlyIncluded />
                <InlineStack
                  align="space-between"
                  blockAlign="center"
                  gap="200"
                >
                  <Text as="p" tone="subdued">
                    {totals
                      ? totals.toChange
                        ? `${totals.toChange} price${totals.toChange === 1 ? "" : "s"} would change at today's rates.`
                        : "Your prices match today's rates."
                      : ""}
                  </Text>
                  <Button variant="primary" url="/app/updates">
                    Update prices
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <AutoCard auto={data.auto} />
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Recent updates
                    </Text>
                    <Link to="/app/history">History</Link>
                  </InlineStack>
                  <RecentUpdates runs={runs} now={now} />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    24k trend
                  </Text>
                  <Sparkline history={data.history} />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </AppPage>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
