import { useCallback, useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Tabs,
  Text,
} from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  KaratCards,
  NoticeBanner,
  PreviewTable,
  ShopAlerts,
  SkippedTable,
  Stat,
  usePageAction,
  useShop,
} from "../components/ui";
import { activeFormulaOf } from "../components/pricing";
import { loadContext, pageAction } from "../lib/pages.server";
import { karatPrices } from "../lib/pricing";

export const meta = () => [{ title: "Price Updates · Gold Price Editor" }];
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  return json(ctx.common);
};
export const action = pageAction;

function resultNotice(d) {
  const verb = d.intent === "apply" ? "Updated" : "Restored";
  const skippedCount = d.skipped?.length || 0;
  return {
    tone: d.errors?.length || skippedCount ? "warning" : "success",
    title:
      `${verb} ${d.updatedCount} variant price${d.updatedCount === 1 ? "" : "s"}.` +
      (skippedCount
        ? ` ${skippedCount} skipped because the price was changed in Shopify after the preview.`
        : " You can undo this on the History page."),
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
  };
}

function PreviewCard({ preview, busyIntent, busy, onDiscard, onApply }) {
  const { money, formatDate } = useShop();
  const [selected, setSelected] = useState(() =>
    preview.rows.filter((r) => !r.unchanged).map((r) => r.variantId),
  );
  const [tab, setTab] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const selectedRows = preview.rows.filter((r) =>
    selected.includes(r.variantId),
  );
  const flaggedSelected = selectedRows.filter((r) => r.flagged).length;
  const warn = preview.warnChangePct;

  return (
    <Card padding="0">
      <Box padding="400">
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingLg">
                Price preview
              </Text>
              <Text as="p" tone="subdued">
                Based on 24k at {money.format(preview.snapshot.gram24)} / g ·{" "}
                {formatDate(preview.snapshot.at)} · {preview.productCount}{" "}
                products scanned
              </Text>
              {preview.vatBlocked && (
                <Text as="p" variant="bodySm" tone="caution">
                  VAT was not added: your Shopify store adds tax at checkout.
                </Text>
              )}
            </BlockStack>
            <InlineStack gap="200">
              <Button onClick={onDiscard} disabled={busy}>
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
              label={`Change over ${warn}%`}
              value={preview.rows.filter((r) => r.flagged).length}
              tone={
                preview.rows.some((r) => r.flagged) ? "critical" : undefined
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
                onAction: () => onApply(selectedRows.map((r) => r.variantId)),
              }}
              secondaryAction={{
                content: "Cancel",
                onAction: () => setConfirming(false),
              }}
            >
              <p>
                {flaggedSelected
                  ? `${flaggedSelected} of them change by more than ${warn}%. Check them first. `
                  : ""}
                You can undo this run on the History page.
              </p>
            </Banner>
          )}
        </BlockStack>
      </Box>
      <Tabs
        tabs={[
          { id: "update", content: `To update (${preview.rows.length})` },
          { id: "skipped", content: `Skipped (${preview.skipped.length})` },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      {tab === 0 ? (
        preview.rows.length ? (
          <PreviewTable
            rows={preview.rows}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          <EmptyState heading="No matching products" image="">
            <p>
              Check the Skipped tab to see why products weren&apos;t matched.
            </p>
          </EmptyState>
        )
      ) : (
        <>
          {preview.skipped.length > 0 && (
            <Box padding="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Set the missing karat, origin or weight on the{" "}
                <Link to="/app/products">Products</Link> page.
              </Text>
            </Box>
          )}
          <SkippedTable skipped={preview.skipped} />
        </>
      )}
    </Card>
  );
}

export default function PriceUpdates() {
  const data = useLoaderData();
  const { settings, live } = data;
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const prices = useMemo(() => karatPrices(live, settings), [live, settings]);
  const formula = activeFormulaOf(settings);

  const onResult = useCallback((d) => {
    if (d.error) return setNotice({ tone: "critical", title: d.error });
    if (d.intent === "preview") {
      setPreview(d);
      setNotice(null);
    }
    if (d.intent === "apply") {
      setNotice(resultNotice(d));
      setPreview(null);
    }
  }, []);
  const { submit, busyIntent, busy } = usePageAction(
    "/app/updates?_data=routes%2Fapp.updates",
    onResult,
  );
  const runPreview = () => submit({ intent: "preview" });

  return (
    <AppPage
      shop={data.shop}
      title="Price Updates"
      subtitle="Preview new prices, choose which to change, then apply"
      primaryAction={{
        content: preview ? "Preview again" : "Preview new prices",
        onAction: runPreview,
        loading: busyIntent === "preview",
        disabled: busy,
      }}
    >
      <BlockStack gap="400">
        <ShopAlerts live={live} settings={settings} shop={data.shop} />
        <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

        {preview ? (
          <PreviewCard
            key={preview.previewId}
            preview={preview}
            busy={busy}
            busyIntent={busyIntent}
            onDiscard={() => setPreview(null)}
            onApply={(variantIds) =>
              submit({
                intent: "apply",
                previewId: preview.previewId,
                variantIds,
              })
            }
          />
        ) : (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Ready to update
                </Text>
                <Text as="p" tone="subdued">
                  The preview uses these prices per gram and your{" "}
                  <strong>{formula.name}</strong> formula. Nothing changes in
                  your store until you press Apply.
                </Text>
              </BlockStack>
              <KaratCards prices={prices} settings={settings} onlyIncluded />
              <Box
                background="bg-surface-secondary"
                padding="300"
                borderRadius="200"
              >
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">
                    <code>{formula.expression}</code>
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {settings.vat.enabled && data.taxesIncluded !== false
                      ? `+ VAT ${settings.vat.pct}% on ${settings.vat.basis === "workmanship" ? "workmanship" : "the total"}, then rounded.`
                      : "Then rounded. No VAT."}{" "}
                    Change it on the <Link to="/app/pricing">Pricing</Link>{" "}
                    page, or the prices per gram on{" "}
                    <Link to="/app/rates">Metal Rates</Link>.
                  </Text>
                </BlockStack>
              </Box>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  size="large"
                  onClick={runPreview}
                  loading={busyIntent === "preview"}
                  disabled={busy}
                >
                  Preview new prices
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </AppPage>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
