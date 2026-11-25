// Formatting shared by the dashboard and the products screen. Pure, runs anywhere.

// Money is always shown in the store's Shopify currency.
function moneyFormat(currency, digits) {
  const base = { style: "currency", currency, maximumFractionDigits: digits };
  try {
    return new Intl.NumberFormat("en-US", base);
  } catch {
    try {
      // Currencies with more decimals by default (e.g. KWD) need a lower minimum.
      return new Intl.NumberFormat("en-US", {
        ...base,
        minimumFractionDigits: 0,
      });
    } catch {
      const n = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
      });
      return { format: (v) => `${currency} ${n.format(v)}` };
    }
  }
}

export function shopFormat({
  currency = "EGP",
  timeZone = "Africa/Cairo",
} = {}) {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  return {
    currency,
    money: moneyFormat(currency, 2),
    money0: moneyFormat(currency, 0),
    // Fixed (store) time zone so the server and the browser show the same time.
    formatDate: (iso) =>
      new Date(iso).toLocaleString("en-GB", {
        timeZone: tz,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
  };
}
