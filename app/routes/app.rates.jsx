import { useMemo } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  BlockStack,
  Card,
  InlineGrid,
  Layout,
  Text,
  TextField,
} from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  KaratCards,
  LiveHero,
  NoticeBanner,
  RateHistory,
  SaveBar,
  ShopAlerts,
  Sparkline,
  num,
  useLivePrice,
  useSettingsForm,
  useShop,
} from "../components/ui";
import { loadContext, pageAction } from "../lib/pages.server";
import { recentRates } from "../lib/goldPrice.server";
import { PURITIES, karatPrices } from "../lib/pricing";

export const meta = () => [{ title: "Metal Rates · Gold Price Editor" }];
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  const history = await recentRates(14, ctx.currency);
  return json({ ...ctx.common, history });
};
export const action = pageAction;

const KEYS = [
  "premiumPct",
  "silverPremiumPct",
  "usdEgpOverride",
  "karatOverrides",
];

function PriceTable({ settings, setSettings, prices }) {
  const { currency } = useShop();
  const setOverride = (k, value) =>
    setSettings((s) => ({
      ...s,
      karatOverrides: { ...s.karatOverrides, [k]: value },
    }));
  return (
    <div className="gpe-scroll">
      <table className="gpe-matrix" style={{ minWidth: 380 }}>
        <thead>
          <tr>
            <th>Purity</th>
            <th>Live ({currency}/g)</th>
            <th>Manual price ({currency}/g)</th>
          </tr>
        </thead>
        <tbody>
          {PURITIES.map(({ key: k, label }) => (
            <tr
              key={k}
              style={{
                opacity: settings.includeKarats.includes(k) ? 1 : 0.6,
              }}
            >
              <td>
                <Text as="span" fontWeight="semibold">
                  {label}
                </Text>
              </td>
              <td className="gpe-num">
                {prices.byKarat[k].livePrice > 0
                  ? num.format(
                      Math.round(prices.byKarat[k].livePrice * 100) / 100,
                    )
                  : "—"}
              </td>
              <td>
                <TextField
                  label={`${label} manual price per gram`}
                  labelHidden
                  type="number"
                  value={settings.karatOverrides[k]}
                  placeholder="Use live price"
                  onChange={(v) => setOverride(k, v)}
                  autoComplete="off"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MetalRates() {
  const data = useLoaderData();
  const form = useSettingsForm(
    data.settings,
    KEYS,
    "/app/rates?_data=routes%2Fapp.rates",
  );
  const { settings, setSettings, set } = form;
  const { live, refresh, refreshing, now, trend } = useLivePrice(data.live);
  const prices = useMemo(() => karatPrices(live, settings), [live, settings]);
  const currency = data.shop.currency;

  return (
    <AppPage
      shop={data.shop}
      title="Metal Rates"
      subtitle="Live gold and silver prices, converted to your store currency"
      primaryAction={{
        content: "Save",
        onAction: form.save,
        loading: form.saving,
        disabled: !form.dirty,
      }}
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
        <ShopAlerts
          live={live}
          settings={settings}
          shop={data.shop}
          savedCurrency={form.savedCurrency}
        />
        <NoticeBanner
          notice={form.notice}
          onDismiss={() => form.setNotice(null)}
        />
        <KaratCards prices={prices} settings={settings} />

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Your rates
                  </Text>
                  <Text as="p" tone="subdued">
                    Karat price = 24k price × karat ÷ 24. 24k price = spot
                    USD/oz ÷ 31.1035 × USD→{currency} × (1 + premium). Silver
                    works the same way: 925 = 92.5% of the fine silver price.
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
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Price per gram
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Leave a manual price empty to follow the live price, or type
                    a price to fix it. Faded rows are karats switched off in
                    Settings.
                  </Text>
                </BlockStack>
                <PriceTable
                  settings={settings}
                  setSettings={setSettings}
                  prices={prices}
                />
                <SaveBar form={form} />
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Last 14 days
                </Text>
                <Sparkline history={data.history} />
                <Text as="p" variant="bodySm" tone="subdued">
                  Pure metal per gram in {currency}, before your premium.
                </Text>
                <RateHistory history={data.history} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </AppPage>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
