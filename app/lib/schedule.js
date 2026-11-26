// Times for automatic price updates. A store picks clock times ("10:00") in its own
// Shopify time zone; these helpers turn them into exact moments.

export const MAX_AUTO_TIMES = 4;
// If the timer was late (the server was asleep), a time is still run up to this long
// after it was due. Older missed times are not run.
export const CATCH_UP_MS = 3 * 60 * 60 * 1000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Keep valid "HH:MM" times, sorted, without repeats, at most MAX_AUTO_TIMES. */
export function cleanTimes(input) {
  const list = Array.isArray(input) ? input : [];
  return [...new Set(list.map(String).filter((t) => TIME_RE.test(t)))]
    .sort()
    .slice(0, MAX_AUTO_TIMES);
}

function zoneOrUtc(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

// Calendar date and clock time of `date` in `timeZone`.
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    min: get("minute"),
  };
}

// The UTC moment when the clock in `timeZone` shows y-m-d h:min.
function zonedToUtc(y, m, d, h, min, timeZone) {
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  let t = asUtc;
  // Two passes settle the offset, including on daylight-saving change days.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), timeZone);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t = t + (asUtc - shown);
  }
  return t;
}

// Every scheduled moment on the local days around `now` (yesterday, today, tomorrow).
function momentsAround(times, timeZone, now) {
  const tz = zoneOrUtc(timeZone);
  const out = [];
  for (const dayShift of [-1, 0, 1]) {
    const day = localParts(new Date(now + dayShift * 86400000), tz);
    for (const t of cleanTimes(times)) {
      const [h, min] = t.split(":").map(Number);
      out.push(zonedToUtc(day.y, day.m, day.d, h, min, tz));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The scheduled moment that is due now: the latest one at or before `now` and no more
 * than CATCH_UP_MS ago. Returns a Date, or null when nothing is due.
 */
export function dueSlot(times, timeZone, now = Date.now()) {
  const due = momentsAround(times, timeZone, now).filter(
    (t) => t <= now && now - t <= CATCH_UP_MS,
  );
  return due.length ? new Date(due[due.length - 1]) : null;
}

/** The next scheduled moment after `now`, or null when there are no times. */
export function nextSlot(times, timeZone, now = Date.now()) {
  const next = momentsAround(times, timeZone, now).find((t) => t > now);
  return next ? new Date(next) : null;
}
