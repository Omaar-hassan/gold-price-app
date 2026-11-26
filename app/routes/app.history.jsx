import { useCallback, useState } from "react";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { FriendlyError } from "../components/FriendlyError";
import {
  AppPage,
  autoStatus,
  NoticeBanner,
  runLabel,
  usePageAction,
  useShop,
} from "../components/ui";
import { loadContext, pageAction } from "../lib/pages.server";
import { getRun, recentRuns } from "../lib/store.server";
import { recentAutoRuns } from "../lib/auto.server";

export const meta = () => [{ title: "History · Gold Price Editor" }];
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  const [runs, autoRuns] = await Promise.all([
    recentRuns(ctx.shopDomain, 50),
    recentAutoRuns(ctx.shopDomain, 20),
  ]);
  // Details of one run, when ?run=<id> is in the URL.
  const runId = Number(new URL(request.url).searchParams.get("run"));
  let detail = null;
  if (runId) {
    const run = await getRun(ctx.shopDomain, runId);
    if (run) {
      let changes = [];
      try {
        changes = JSON.parse(run.changes || "[]");
      } catch {
        changes = [];
      }
      detail = { id: run.id, kind: run.kind, changes };
    }
  }
  return json({ shop: ctx.common.shop, runs, autoRuns, detail });
};
export const action = pageAction;

function RunDetail({ detail }) {
  const { money } = useShop();
  return (
    <Card padding="0">
      <Box padding="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            {runLabel(detail.kind)} #{detail.id}: {detail.changes.length} price
            {detail.changes.length === 1 ? "" : "s"}
          </Text>
          <Link to="/app/history">Close</Link>
        </InlineStack>
      </Box>
      {detail.changes.length ? (
        <IndexTable
          resourceName={{ singular: "price", plural: "prices" }}
          itemCount={detail.changes.length}
          selectable={false}
          headings={[
            { title: "Product" },
            { title: "Before", alignment: "end" },
            { title: "After", alignment: "end" },
          ]}
        >
          {detail.changes.map((c, i) => (
            <IndexTable.Row id={c.variantId} key={c.variantId} position={i}>
              <IndexTable.Cell>
                <BlockStack gap="050">
                  <Text as="span" fontWeight="semibold">
                    {c.productTitle}
                  </Text>
                  {c.variantTitle && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {c.variantTitle}
                    </Text>
                  )}
                </BlockStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" alignment="end" numeric tone="subdued">
                  {money.format(Number(c.oldPrice) || 0)}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" alignment="end" numeric fontWeight="semibold">
                  {money.format(Number(c.newPrice) || 0)}
                </Text>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      ) : (
        <Box padding="400">
          <Text as="p" tone="subdued">
            No prices were changed in this run.
          </Text>
        </Box>
      )}
    </Card>
  );
}

export default function History() {
  const data = useLoaderData();
  const [runs, setRuns] = useState(data.runs);
  const [notice, setNotice] = useState(null);
  const onResult = useCallback((d) => {
    if (d.error) return setNotice({ tone: "critical", title: d.error });
    if (d.intent === "undo") {
      const skipped = d.skipped?.length || 0;
      setNotice({
        tone: d.errors?.length || skipped ? "warning" : "success",
        title:
          `Restored ${d.updatedCount} price${d.updatedCount === 1 ? "" : "s"}.` +
          (skipped
            ? ` ${skipped} left alone because they were changed in Shopify after the update.`
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
    }
  }, []);
  const { submit, busyIntent, busy } = usePageAction(
    "/app/history?_data=routes%2Fapp.history",
    onResult,
  );
  // Only the most recent update can be undone (older ones may have been overwritten).
  const latestUndoable = runs.find(
    (r) =>
      (r.kind === "apply" || r.kind === "auto") &&
      !r.undone &&
      r.updatedCount > 0,
  );

  return (
    <AppPage
      shop={data.shop}
      title="History"
      subtitle="Every price update, with undo for the latest one"
    >
      <BlockStack gap="400">
        <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
        {data.detail && <RunDetail detail={data.detail} />}
        <HistoryTable
          runs={runs}
          latestUndoable={latestUndoable}
          busy={busy}
          busyIntent={busyIntent}
          onUndo={(id) => submit({ intent: "undo", runId: id })}
        />
        {data.autoRuns.length > 0 && <AutoChecks autoRuns={data.autoRuns} />}
      </BlockStack>
    </AppPage>
  );
}

// Every automatic check, including ones that changed nothing or were skipped (those
// have no row in the table above, because no price changed).
function AutoChecks({ autoRuns }) {
  const { formatDate } = useShop();
  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text as="h2" variant="headingMd">
            Automatic checks
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Each scheduled time, including the ones that changed nothing.
          </Text>
        </BlockStack>
        {autoRuns.map((r) => {
          const status = autoStatus(r);
          return (
            <BlockStack key={r.id} gap="050">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <Text as="span" fontWeight="semibold">
                  {formatDate(r.slot)}
                  {r.updatedCount
                    ? ` · ${r.updatedCount} price${r.updatedCount === 1 ? "" : "s"} updated`
                    : ""}
                </Text>
                <Badge tone={status.tone}>{status.label}</Badge>
              </InlineStack>
              {r.message && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {r.message}
                </Text>
              )}
            </BlockStack>
          );
        })}
      </BlockStack>
    </Card>
  );
}

function HistoryTable({ runs, latestUndoable, busy, busyIntent, onUndo }) {
  const { money0, formatDate } = useShop();
  if (!runs.length)
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="p" tone="subdued">
            No price updates yet.
          </Text>
          <Text as="p">
            Go to <Link to="/app/updates">Price Updates</Link> to preview and
            apply your first update.
          </Text>
        </BlockStack>
      </Card>
    );
  return (
    <Card padding="0">
      <IndexTable
        resourceName={{ singular: "update", plural: "updates" }}
        itemCount={runs.length}
        selectable={false}
        headings={[
          { title: "When" },
          { title: "Type" },
          { title: "Prices", alignment: "end" },
          { title: "24k / g", alignment: "end" },
          { title: "" },
        ]}
      >
        {runs.map((r, i) => (
          <IndexTable.Row id={String(r.id)} key={r.id} position={i}>
            <IndexTable.Cell>{formatDate(r.createdAt)}</IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack gap="100">
                <Badge
                  tone={
                    r.kind === "undo"
                      ? "info"
                      : r.kind === "auto"
                        ? "success"
                        : undefined
                  }
                >
                  {r.kind === "auto" ? "Automatic" : runLabel(r.kind)}
                </Badge>
                {r.undone && <Badge>Undone</Badge>}
                {r.failedCount > 0 && (
                  <Badge tone="critical">{`${r.failedCount} failed`}</Badge>
                )}
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" alignment="end" numeric>
                {r.updatedCount}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" alignment="end" numeric tone="subdued">
                {r.gram24 ? money0.format(r.gram24) : "—"}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack gap="200" align="end" wrap={false}>
                <Link to={`/app/history?run=${r.id}`}>Details</Link>
                {latestUndoable?.id === r.id && (
                  <Button
                    size="slim"
                    onClick={() => onUndo(r.id)}
                    loading={busyIntent === "undo"}
                    disabled={busy}
                  >
                    Undo
                  </Button>
                )}
              </InlineStack>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    </Card>
  );
}

export function ErrorBoundary() {
  return <FriendlyError error={useRouteError()} />;
}
