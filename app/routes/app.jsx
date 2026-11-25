import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { FriendlyError } from "../components/FriendlyError";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/products">Products</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
// Anything else (a network blip, a crash) gets a friendly screen with a Reload button.
export function ErrorBoundary() {
  const error = useRouteError();
  const name = error?.constructor?.name;
  if (name === "ErrorResponse" || name === "ErrorResponseImpl")
    return boundary.error(error);
  return <FriendlyError error={error} />;
}

// The dashboard keeps its own state after its actions, so don't reload this
// layout's loader after each save/preview/apply/undo.
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? false : defaultShouldRevalidate;

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
