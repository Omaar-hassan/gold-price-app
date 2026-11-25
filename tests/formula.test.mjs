import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATES,
  evaluateFormula,
  parseFormula,
  validateFormula,
  vatAmount,
} from "../app/lib/formula.js";
import {
  buildPlan,
  karatPrices,
  normalizeSettings,
} from "../app/lib/pricing.js";

const vars = {
  metal_price: 5388,
  weight: 5,
  making: 100,
  making_pct: 0,
  wastage_pct: 2,
  stone_cost: 0,
  fixed_fee: 50,
  profit_pct: 10,
  discount: 0,
};
const tpl = (id) => TEMPLATES.find((t) => t.id === id).expression;

test("templates calculate the agreed examples", () => {
  // Classic = today's formula
  assert.equal(
    evaluateFormula(tpl("classic"), { ...vars, discount: 20 }),
    5388 * 5 + 500 - 20,
  );
  // Full cost plus profit: (27,478.80 + 500 + 0 + 50) x 1.10 = 30,831.68
  assert.equal(
    Math.round(evaluateFormula(tpl("fullcost"), vars) * 100) / 100,
    30831.68,
  );
  // Making % of gold value: 26,940 x (1 + 0.08 + 0.02) + 1,000 stones
  assert.equal(
    Math.round(
      evaluateFormula(tpl("makingpct"), {
        ...vars,
        making_pct: 8,
        stone_cost: 1000,
      }) * 100,
    ) / 100,
    Math.round((26940 * 1.1 + 1000) * 100) / 100,
  );
  for (const t of TEMPLATES)
    assert.equal(validateFormula(t.expression).ok, true, t.id);
});

test("operator precedence, brackets, unary minus, × and ÷", () => {
  assert.equal(evaluateFormula("2 + 3 * 4", {}), 14);
  assert.equal(evaluateFormula("(2 + 3) * 4", {}), 20);
  assert.equal(evaluateFormula("-weight + 10", { weight: 4 }), 6);
  assert.equal(evaluateFormula("10 ÷ 4 × 2", {}), 5);
  assert.equal(evaluateFormula("metal_price * weight", { weight: 2 }), 0); // missing = 0
});

test("unsafe or broken formulas are rejected, never run", () => {
  const bad = [
    "process.exit()",
    "constructor",
    "metal_price * weight; alert(1)",
    "metal_price ** 2",
    "Math.max(1,2)",
    "metal_price * (weight",
    "metal_price * weight)",
    "",
    "1 +",
    "metal_price[0]",
    "`x`",
  ];
  for (const f of bad) assert.throws(() => parseFormula(f), undefined, f);
  assert.match(validateFormula("making * 2").error, /weight/);
  assert.match(validateFormula("weight * 2").error, /metal_price/);
  assert.throws(
    () => evaluateFormula("metal_price * weight / (wastage_pct - 2)", vars),
    /Division by zero/,
  );
  assert.throws(() => parseFormula("x".repeat(501)), /too long/);
});

test("VAT on total or on workmanship only", () => {
  const v = { metal_price: 5000, weight: 10, making: 100, making_pct: 0 };
  assert.equal(vatAmount(51000, v, { enabled: false, pct: 14 }), 0);
  assert.equal(
    Math.round(vatAmount(51000, v, { enabled: true, pct: 14, basis: "total" })),
    7140,
  );
  assert.equal(
    Math.round(
      vatAmount(51000, v, { enabled: true, pct: 14, basis: "workmanship" }),
    ),
    140,
  );
  // making % counts as workmanship too
  assert.equal(
    Math.round(
      vatAmount(
        0,
        { ...v, making: 0, making_pct: 10 },
        { enabled: true, pct: 14, basis: "workmanship" },
      ),
    ),
    700,
  );
});

const product = (title, metafields = []) => ({
  id: "gid://shopify/Product/1",
  title,
  tags: [],
  metafields,
  variants: [
    { id: "gid://shopify/ProductVariant/1", title: "", sku: "", price: "1000" },
  ],
});
const live = { usdPerOunce: 3110.34768, usdRate: 50 }; // 24k = 5,000 EGP/g

test("plan: default settings give exactly today's prices", () => {
  const s = normalizeSettings({
    making: { 21: { local: 100 } },
    rounding: "1",
  });
  const { rows } = buildPlan(
    [product("Ring 21k Local 5g")],
    s,
    karatPrices(live, s),
  );
  assert.equal(rows[0].newPrice, (4375 + 100) * 5);
});

test("plan: switching formulas keeps the saved values; product fields override shop values", () => {
  const base = {
    making: { 21: { local: 100 } },
    rounding: "0.01",
    wastagePct: 2,
    fixedFee: 50,
    profitPct: 10,
  };
  const full = normalizeSettings({ ...base, activeFormulaId: "fullcost" });
  const p = [
    product("Ring 21k Local 5g", [{ key: "stone_cost", value: "1,500" }]),
  ];
  const a = buildPlan(p, full, karatPrices(live, full)).rows[0];
  // (4375*5*1.02 + 500 + 1500 + 50) * 1.1
  assert.equal(
    a.newPrice,
    Math.round((4375 * 5 * 1.02 + 2050) * 1.1 * 100) / 100,
  );
  // switch to classic: same settings object, values still there
  const classic = normalizeSettings({ ...full, activeFormulaId: "classic" });
  assert.equal(classic.wastagePct, 2);
  assert.equal(classic.profitPct, 10);
  assert.equal(
    buildPlan(p, classic, karatPrices(live, classic)).rows[0].newPrice,
    4475 * 5,
  );
  // product profit_pct overrides the shop's 10%
  const p2 = [
    product("Ring 21k Local 5g", [{ key: "profit_pct", value: "0" }]),
  ];
  assert.equal(
    buildPlan(p2, full, karatPrices(live, full)).rows[0].newPrice,
    Math.round((4375 * 5 * 1.02 + 550) * 100) / 100,
  );
});

test("plan: VAT is added after the formula, and blocked when Shopify adds tax at checkout", () => {
  const s = normalizeSettings({
    making: { 21: { local: 100 } },
    rounding: "0.01",
    vat: { enabled: true, pct: 14, basis: "workmanship" },
  });
  const p = [product("Ring 21k Local 5g")];
  const withVat = buildPlan(p, s, karatPrices(live, s), {
    taxesIncluded: true,
  });
  assert.equal(withVat.rows[0].vat, 70); // 14% of 500 workmanship
  assert.equal(withVat.rows[0].newPrice, 22375 + 70);
  const blocked = buildPlan(p, s, karatPrices(live, s), {
    taxesIncluded: false,
  });
  assert.equal(blocked.vatBlocked, true);
  assert.equal(blocked.rows[0].vat, 0);
  assert.equal(blocked.rows[0].newPrice, 22375);
});

test("plan: custom formulas are saved, edited templates can be reset, bad formulas stop the preview", () => {
  const s = normalizeSettings({
    formulas: [
      { id: "classic", name: "Renamed?", expression: "metal_price * weight" },
      {
        id: "custom-1",
        name: "Round up",
        expression: "metal_price * weight + 999",
      },
      { id: "evil", name: "x", expression: "1" },
    ],
    activeFormulaId: "custom-1",
  });
  assert.equal(s.formulas.length, 6); // 5 templates + 1 custom ("evil" dropped)
  assert.equal(s.formulas[0].name, "Classic"); // template names are fixed
  assert.equal(s.formulas[0].expression, "metal_price * weight"); // edit kept
  const r = buildPlan(
    [product("Ring 21k Local 5g")],
    s,
    karatPrices(live, normalizeSettings({})),
  );
  assert.equal(r.rows[0].newPrice, 4375 * 5 + 999); // custom formula used
  const bad = normalizeSettings({
    formulas: [
      { id: "custom-2", name: "Broken", expression: "metal_price * (" },
    ],
    activeFormulaId: "custom-2",
  });
  assert.match(
    buildPlan([], bad, karatPrices(live, bad)).formulaError,
    /Broken/,
  );
  // unknown active id falls back to classic
  assert.equal(
    normalizeSettings({ activeFormulaId: "nope" }).activeFormulaId,
    "classic",
  );
});
