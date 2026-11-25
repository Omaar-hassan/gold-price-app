import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  NoticeBanner,
  SaveBar,
  ShopAlerts,
  useSettingsForm,
} from "../components/ui";
import { loadContext, pageAction } from "../lib/pages.server";
import { PURITIES } from "../lib/pricing";

export const meta = () => [{ title: "Settings · Gold Price Editor" }];
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  return json(ctx.common);
};
export const action = pageAction;

const KEYS = ["includeKarats", "unknownOrigin", "warnChangePct"];

function Fact({ label, value, tone }) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="200">
      <Text as="span" tone="subdued">
        {label}
      </Text>
      {tone ? (
        <Badge tone={tone}>{value}</Badge>
      ) : (
        <Text as="span">{value}</Text>
      )}
    </InlineStack>
  );
}

export default function Settings() {
  const data = useLoaderData();
  const form = useSettingsForm(
    data.settings,
    KEYS,
    "/app/settings?_data=routes%2Fapp.settings",
  );
  const { settings, set } = form;
  const toggle = (k, on) =>
    set(
      "includeKarats",
      on
        ? [...new Set([...settings.includeKarats, k])]
        : settings.includeKarats.filter((x) => x !== k),
    );
  const tax = data.taxesIncluded;

  return (
    <AppPage
      shop={data.shop}
      title="Settings"
      subtitle="General options for price updates"
      primaryAction={{
        content: "Save",
        onAction: form.save,
        loading: form.saving,
        disabled: !form.dirty,
      }}
    >
      <BlockStack gap="400">
        <ShopAlerts
          live={data.live}
          settings={settings}
          shop={data.shop}
          savedCurrency={form.savedCurrency}
        />
        <NoticeBanner
          notice={form.notice}
          onDismiss={() => form.setNotice(null)}
        />
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Karats to update
                    </Text>
                    <Text as="p" tone="subdued">
                      Only products with these karats or purities get new
                      prices. The others are left alone.
                    </Text>
                  </BlockStack>
                  <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }} gap="200">
                    {PURITIES.map((p) => (
                      <Checkbox
                        key={p.key}
                        label={
                          p.metal === "silver" ? p.label : `Gold ${p.label}`
                        }
                        checked={settings.includeKarats.includes(p.key)}
                        onChange={(on) => toggle(p.key, on)}
                      />
                    ))}
                  </InlineGrid>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Safety
                  </Text>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <Select
                      label="Products with no origin"
                      options={[
                        { label: "Skip them", value: "skip" },
                        { label: "Treat as local", value: "local" },
                        { label: "Treat as imported", value: "imported" },
                      ]}
                      value={settings.unknownOrigin}
                      onChange={(v) => set("unknownOrigin", v)}
                      helpText="Origin picks the local or imported making charge."
                    />
                    <TextField
                      label="Warn about changes bigger than"
                      type="number"
                      suffix="%"
                      value={String(settings.warnChangePct)}
                      onChange={(v) => set("warnChangePct", v)}
                      helpText="These are highlighted in red in the preview."
                      autoComplete="off"
                    />
                  </InlineGrid>
                </BlockStack>
              </Card>
              <SaveBar form={form} />
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Your store
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Read from Shopify. Change these in your Shopify admin
                    settings.
                  </Text>
                  <Fact
                    label="Currency"
                    value={
                      data.shop.currencyKnown
                        ? data.shop.currency
                        : `${data.shop.currency} (could not read)`
                    }
                  />
                  <Fact
                    label="Prices include tax"
                    value={
                      tax === true ? "Yes" : tax === false ? "No" : "Unknown"
                    }
                    tone={tax === null ? "warning" : undefined}
                  />
                  <Fact label="Time zone" value={data.shop.timeZone} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    How products are matched
                  </Text>
                  <Text as="p" variant="bodySm">
                    <strong>Karat</strong>: metafield <code>karat</code>, then
                    the title, tags, product type or SKU (e.g. “21k”, “21
                    karat”, “عيار 21”).
                  </Text>
                  <Text as="p" variant="bodySm">
                    <strong>Silver</strong>: the <code>metal</code> metafield,
                    title, tags, type or SKU says “silver”, “sterling” or “فضة”,
                    or carries the 925 hallmark.
                  </Text>
                  <Text as="p" variant="bodySm">
                    <strong>Origin</strong>: metafield <code>origin</code>, then
                    title, tags or product type (“local”, “محلي”, “imported”,
                    “مستورد”).
                  </Text>
                  <Text as="p" variant="bodySm">
                    <strong>Weight</strong>: metafield <code>metal_weight</code>
                    , variant title (“5.5g”), SKU (e.g. GLD-21K-LOC-5.5),
                    product title, tags, then the shipping weight.
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Anything set with Fix on the Products page wins over all of
                    these.
                  </Text>
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
