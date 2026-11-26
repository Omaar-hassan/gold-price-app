import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCH_UP_MS,
  cleanTimes,
  dueSlot,
  nextSlot,
} from "../app/lib/schedule.js";
import { normalizeSettings } from "../app/lib/pricing.js";

const at = (iso) => Date.parse(iso);

test("cleanTimes keeps valid times, sorted, unique, max 4", () => {
  assert.deepEqual(
    cleanTimes([
      "18:00",
      "10:00",
      "10:00",
      "25:00",
      "9:00",
      "x",
      "06:30",
      "12:00",
      "20:00",
    ]),
    ["06:30", "10:00", "12:00", "18:00"],
  );
  assert.deepEqual(cleanTimes(null), []);
});

test("dueSlot uses the store time zone (Cairo is UTC+2 in November)", () => {
  // 10:00 Cairo = 08:00 UTC.
  assert.equal(
    dueSlot(["10:00"], "Africa/Cairo", at("2026-11-25T07:59:00Z")),
    null,
  );
  assert.equal(
    dueSlot(
      ["10:00"],
      "Africa/Cairo",
      at("2026-11-25T08:00:00Z"),
    ).toISOString(),
    "2026-11-25T08:00:00.000Z",
  );
  assert.equal(
    dueSlot(
      ["10:00"],
      "Africa/Cairo",
      at("2026-11-25T09:30:00Z"),
    ).toISOString(),
    "2026-11-25T08:00:00.000Z",
  );
});

test("dueSlot ignores times missed by more than the catch-up window", () => {
  const slot = at("2026-11-25T08:00:00Z");
  assert.ok(dueSlot(["10:00"], "Africa/Cairo", slot + CATCH_UP_MS));
  assert.equal(
    dueSlot(["10:00"], "Africa/Cairo", slot + CATCH_UP_MS + 60000),
    null,
  );
});

test("dueSlot picks the latest due time and handles midnight", () => {
  const due = dueSlot(
    ["10:00", "11:00"],
    "Africa/Cairo",
    at("2026-11-25T09:10:00Z"),
  );
  assert.equal(due.toISOString(), "2026-11-25T09:00:00.000Z");
  // 23:30 New York on Nov 24 = 04:30 UTC Nov 25.
  const late = dueSlot(
    ["23:30"],
    "America/New_York",
    at("2026-11-25T05:00:00Z"),
  );
  assert.equal(late.toISOString(), "2026-11-25T04:30:00.000Z");
});

test("dueSlot handles daylight saving time", () => {
  // New York is UTC-4 in July: 10:00 = 14:00 UTC.
  assert.equal(
    dueSlot(
      ["10:00"],
      "America/New_York",
      at("2026-07-01T14:05:00Z"),
    ).toISOString(),
    "2026-07-01T14:00:00.000Z",
  );
});

test("nextSlot and bad time zones", () => {
  assert.equal(
    nextSlot(
      ["10:00"],
      "Africa/Cairo",
      at("2026-11-25T09:00:00Z"),
    ).toISOString(),
    "2026-11-26T08:00:00.000Z",
  );
  assert.equal(nextSlot([], "Africa/Cairo"), null);
  assert.equal(
    dueSlot(["10:00"], "Not/AZone", at("2026-11-25T10:01:00Z")).toISOString(),
    "2026-11-25T10:00:00.000Z",
  );
});

test("automatic updates are off by default and keep saved times", () => {
  assert.deepEqual(normalizeSettings({}).auto, {
    enabled: false,
    times: ["10:00"],
  });
  assert.deepEqual(
    normalizeSettings({ auto: { enabled: true, times: ["18:00", "bad"] } })
      .auto,
    { enabled: true, times: ["18:00"] },
  );
});
