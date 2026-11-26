// Price history of one variant (?variant=<gid>): every price the app set, with a
// button to restore any earlier price. Restoring is always a merchant action with a
// confirm step, and it is logged and kept in History like any other update.
import { useCallback, useState } from "react";
import { json } from "@remix-run/node";
import {
  Link,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import {
  Banner,
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
  NoticeBanner,
  runLabel,
  usePageAction,
  useShop,
} from "../components/ui";
import { actorOf, loadContext } from "../lib/pages.server";
import { authenticate } from "../shopify.server";
import { shopifyConnector } from "../lib/connectors/shopify.server";
import {
  getPriceChange,
  logActivity,
  recordRun,
  variantHistory,
} from "../lib/store.server";

export const meta = () => [{ title: "Price history · Gold Price Editor" }];

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

export const loader = async ({ request }) => {
  const ctx = await loadContext(request);
  const variantId = new URL(request.url).searchParams.get("variant") || "";
  if (!VARIANT_GID.test(variantId))
    return json({ shop: ctx.common.shop, variantId: null, history: [] });
  const [history, current] = await Promise.all([
    variantHistory(ctx.shopDomain, variantId),
    ctx.store.getPrices([variantId]).catch(() => new Map()),
  ]);
  return json({
    shop: ctx.common.shop,
    variantId,
    history,
    currentPrice: current.has(variantId) ? current.get(variantId) : null,
  });
};

export const action = async ({ request }) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const store = shopifyConnector(admin, shop);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, { status: 400 });
  }
  // The price comes from the saved history, never from the browser.
  const change = await getPriceChange(shop, Number(body.changeId));
  if (!change || !["old", "new"].includes(body.which))
    return json(
      { error: "That price is not in the history." },
      { status: 400 },
    );
  const price = body.which === "old" ? change.oldPrice : change.newPrice;
  if (!(price > 0))
    return json({ error: "That price can't be restored." }, { status: 400 });

  try {
    const current = await store.getPrices([change.variantId]);
    if (!current.has(change.variantId))
      return json(
        { error: "This variant no longer exists in Shopify." },
        { status: 404 },
      );
    const currentPrice = current.get(change.variantId);
    if (Math.abs(currentPrice - price) < 0.005)
      return json({ intent: "restore", ok: true, unchanged: true });
    const item = {
      productId: change.productId,
      variantId: change.variantId,
      productTitle: change.productTitle,
      variantTitle: change.variantTitle,
      currentPrice,
      newPrice: price,
    };
    const result = await store.setPrices([item]);
    if (result.errors.length)
      return json(
        { error: `Shopify did not save it: ${result.errors[0].message}` },
        { status: 502 },
      );
    await recordRun(shop, { kind: "restore", ...result });
    await logActivity(
      shop,
      actorOf(sessionToken),
      "restore",
      `Restored ${change.productTitle}${change.variantTitle && change.variantTitle !== "Default Title" ? ` (${change.variantTitle})` : ""} from ${currentPrice.toFixed(2)} to ${price.toFixed(2)}.`,
    );
    return json({ intent: "restore", ok: true, price });
  } catch (error) {
    console.error("[gold-price] restore failed:", error);
    return json(
      { error: "Something went wrong: " + error.message },
      { status: 500 },
    );
  }
};

function HistoryTable({ history, currentPrice, onRestore, busy }) {
  const { money, formatDate } = useShop();
  const [confirm, setConfirm] = useState(null); // { changeId, which, price }
  const same = (p) =>
    currentPrice !== null && Math.abs(p - currentPrice) < 0.005;
  const restoreButton = (h, which) => {
    const price = which === "old" ? h.oldPrice : h.newPrice;
    if (!(price > 0) || same(price)) return null;
    return (
      <Button
        size="slim"
        disabled={busy}
        onClick={() => setConfirm({ changeId: h.id, which, price })}
      >
        {`Restore ${money.format(price)}`}
      </Button>
    );
  };
  return (
    <Card padding="0">
      {confirm && (
        <Box padding="400">
          <Banner
            tone="warning"
            title={`Set this variant's price to ${money.format(confirm.price)} in your store now?`}
            action={{
              content: "Yes, restore",
              loading: busy,
              onAction: () => {
                onRestore(confirm);
                setConfirm(null);
              },
            }}
            secondaryAction={{
              content: "Cancel",
              onAction: () => setConfirm(null),
            }}
          >
            <p>
              The price changes in Shopify straight away. It is saved in
              History, and you can restore another price at any time.
            </p>
          </Banner>
        </Box>
      )}
      <IndexTable
        resourceName={{ singular: "change", plural: "changes" }}
        itemCount={history.length}
        selectable={false}
        headings={[
          { title: "When" },
          { title: "Type" },
          { title: "Before", alignment: "end" },
          { title: "After", alignment: "end" },
          { title: "" },
        ]}
      >
        {history.map((h, i) => (
          <IndexTable.Row id={String(h.id)} key={h.id} position={i}>
            <IndexTable.Cell>{formatDate(h.createdAt)}</IndexTable.Cell>
            <IndexTable.Cell>{runLabel(h.kind)}</IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" alignment="end" numeric tone="subdued">
                {money.format(h.oldPrice)}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" alignment="end" numeric>
                {money.format(h.newPrice)}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack gap="200" align="end" wrap={false}>
                {restoreButton(h, "old")}
              </InlineStack>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    </Card>
  );
}

function CurrentPrice({ price }) {
  const { money } = useShop();
  return (
    <Card>
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" tone="subdued">
          Price in Shopify now
        </Text>
        <Text as="span" variant="headingMd">
          {price !== null ? money.format(price) : "Unknown"}
        </Text>
      </InlineStack>
    </Card>
  );
}

export default function PriceHistory() {
  const data = useLoaderData();
  const revalidator = useRevalidator();
  const [notice, setNotice] = useState(null);
  const onResult = useCallback(
    (d) => {
      if (d.error) return setNotice({ tone: "critical", title: d.error });
      setNotice({
        tone: "success",
        title: d.unchanged
          ? "The price was already that. Nothing changed."
          : "Price restored.",
      });
      revalidator.revalidate();
    },
    [revalidator],
  );
  const { submit, busy } = usePageAction(
    "/app/price-history?_data=routes%2Fapp.price-history",
    onResult,
  );
  const first = data.history[0];
  const title = first
    ? `${first.productTitle}${first.variantTitle && first.variantTitle !== "Default Title" ? ` (${first.variantTitle})` : ""}`
    : "Price history";

  return (
    <AppPage
      shop={data.shop}
      title="Price history"
      subtitle={title}
      backAction={{ content: "Products", url: "/app/products" }}
    >
      <BlockStack gap="400">
        <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
        {data.history.length ? (
          <>
            <CurrentPrice price={data.currentPrice} />
            <HistoryTable
              history={data.history}
              currentPrice={data.currentPrice}
              busy={busy}
              onRestore={(c) =>
                submit({
                  intent: "restore",
                  changeId: c.changeId,
                  which: c.which,
                })
              }
            />
          </>
        ) : (
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                The app hasn&apos;t changed this price yet.
              </Text>
              <Link to="/app/products">Back to Products</Link>
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
