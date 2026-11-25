import { useMemo } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import { BlockStack, Layout } from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  NoticeBanner,
  SaveBar,
  useSettingsForm,
} from "../components/ui";
import {
  FormulaCard,
  MakingChargesCard,
  OptionalCostsCard,
  RulesCard,
  VatCard,
} from "../components/pricing";
import { loadContext, pageAction } from "../lib/pages.server";
import { karatPrices } from "../lib/pricing";

export const meta = () => [{ title: "Pricing · Gold Price Editor" }];
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  return json(ctx.common);
};
export const action = pageAction;

// The settings this page edits (and saves).
const KEYS = [
  "formulas",
  "activeFormulaId",
  "making",
  "wastagePct",
  "makingPct",
  "fixedFee",
  "profitPct",
  "vat",
  "discountPerPiece",
  "rounding",
];

export default function Pricing() {
  const data = useLoaderData();
  const form = useSettingsForm(
    data.settings,
    KEYS,
    "/app/pricing?_data=routes%2Fapp.pricing",
  );
  const { settings, setSettings, set } = form;
  const prices = useMemo(
    () => karatPrices(data.live, settings),
    [data.live, settings],
  );

  return (
    <AppPage
      shop={data.shop}
      title="Pricing"
      subtitle="How each product's price is calculated"
      primaryAction={{
        content: "Save",
        onAction: form.save,
        loading: form.saving,
        disabled: !form.dirty,
      }}
    >
      <BlockStack gap="400">
        <NoticeBanner
          notice={form.notice}
          onDismiss={() => form.setNotice(null)}
        />
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <FormulaCard
                settings={settings}
                setSettings={setSettings}
                prices={prices}
                taxesIncluded={data.taxesIncluded}
              />
              <MakingChargesCard
                settings={settings}
                setSettings={setSettings}
              />
              <OptionalCostsCard settings={settings} set={set} />
            </BlockStack>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <VatCard
                settings={settings}
                set={set}
                taxesIncluded={data.taxesIncluded}
              />
              <RulesCard settings={settings} set={set} />
            </BlockStack>
          </Layout.Section>
        </Layout>
        <SaveBar form={form} />
      </BlockStack>
    </AppPage>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
