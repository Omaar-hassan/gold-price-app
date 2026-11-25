import { isRouteErrorResponse } from "@remix-run/react";

// A calm error screen with a Reload button, used instead of Remix's bare
// "Application Error". Plain HTML on purpose: it must work even when Polaris or
// App Bridge didn't load. Never shows stack traces or server details.
export function FriendlyError({ error }) {
  const network =
    error instanceof TypeError ||
    /fetch|network|load failed/i.test(String(error?.message || ""));
  const title = network
    ? "Lost the connection to the app"
    : "Something went wrong";
  const text = network
    ? "The app server may be waking up or restarting. This usually takes under a minute."
    : "The page hit an unexpected problem. Reloading usually fixes it.";
  const code = isRouteErrorResponse(error) ? ` (error ${error.status})` : "";

  return (
    <div
      style={{
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        maxWidth: 520,
        margin: "48px auto",
        padding: 24,
        background: "#fff",
        border: "1px solid #e3e3e3",
        borderRadius: 12,
        color: "#303030",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>{title}</h1>
      <p style={{ margin: "0 0 16px", lineHeight: 1.5 }}>
        {text}
        {code}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          background: "#303030",
          color: "#fff",
          border: 0,
          borderRadius: 8,
          padding: "8px 16px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}
