// Safe price formulas.
//
// Merchants write formulas like
//   metal_price * weight * (1 + wastage_pct / 100) + making * weight - discount
// This file parses and evaluates them WITHOUT eval() or Function(): only numbers,
// the building blocks below, + - * /, brackets and unary minus are accepted.
// Anything else is rejected with a clear message.
//
// Pure module: runs in the browser (live example), on the server and in tests.

/** The building blocks a formula can use, with their units ({currency} = the store currency). */
export const VARIABLES = [
  {
    name: "metal_price",
    label: "Metal price",
    unit: "{currency} per gram (for the item's karat or purity)",
  },
  { name: "weight", label: "Weight", unit: "grams" },
  { name: "making", label: "Making charge", unit: "{currency} per gram" },
  {
    name: "making_pct",
    label: "Making charge %",
    unit: "% of the metal value",
  },
  { name: "wastage_pct", label: "Wastage %", unit: "% of the metal" },
  {
    name: "stone_cost",
    label: "Stone / diamond cost",
    unit: "{currency} total per piece",
  },
  { name: "fixed_fee", label: "Fixed fee", unit: "{currency} per piece" },
  { name: "profit_pct", label: "Profit %", unit: "%" },
  { name: "discount", label: "Discount", unit: "{currency} per piece" },
];
export const VARIABLE_NAMES = VARIABLES.map((v) => v.name);

/**
 * The 5 ready-made formulas. VAT is never part of a formula: it is added afterwards
 * by the VAT setting (see applyVat), so a formula can't charge it twice.
 * suggestVatBasis: what choosing the template sets the VAT basis to.
 */
export const TEMPLATES = [
  {
    id: "classic",
    name: "Classic",
    description: "Metal value plus making charge per gram, minus discount.",
    expression: "metal_price * weight + making * weight - discount",
  },
  {
    id: "wastage",
    name: "With wastage",
    description: "Adds a wastage % to the metal.",
    expression:
      "metal_price * weight * (1 + wastage_pct / 100) + making * weight - discount",
  },
  {
    id: "egypt",
    name: "Egypt style (VAT on workmanship)",
    description:
      "Classic formula. Choosing it sets VAT to apply to the workmanship only.",
    expression: "metal_price * weight + making * weight - discount",
    suggestVatBasis: "workmanship",
  },
  {
    id: "fullcost",
    name: "Full cost plus profit",
    description:
      "Metal with wastage, making, stones and fixed fee, plus a profit %.",
    expression:
      "(metal_price * weight * (1 + wastage_pct / 100) + making * weight + stone_cost + fixed_fee) * (1 + profit_pct / 100) - discount",
    suggestVatBasis: "total",
  },
  {
    id: "makingpct",
    name: "Making charge as % of gold value",
    description: "Making charge and wastage as a % of the metal value.",
    expression:
      "metal_price * weight * (1 + making_pct / 100 + wastage_pct / 100) + stone_cost - discount",
  },
];
export const TEMPLATE_BY_ID = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
);

export const MAX_EXPRESSION_LENGTH = 500;

// ---------------------------------------------------------------------------
// Tokenizer + parser (recursive descent) -> small AST
// ---------------------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = text.slice(i).match(/^(\d+(\.\d+)?|\.\d+)/);
      if (!m) throw new Error(`Invalid number at position ${i + 1}`);
      tokens.push({ type: "num", value: Number(m[0]), pos: i });
      i += m[0].length;
    } else if (/[a-z_]/i.test(ch)) {
      const m = text.slice(i).match(/^[a-z_][a-z0-9_]*/i);
      tokens.push({ type: "name", value: m[0].toLowerCase(), pos: i });
      i += m[0].length;
    } else if ("+-*/()".includes(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
    } else if (ch === "×") {
      tokens.push({ type: "op", value: "*", pos: i });
      i++;
    } else if (ch === "÷") {
      tokens.push({ type: "op", value: "/", pos: i });
      i++;
    } else {
      throw new Error(`"${ch}" is not allowed (position ${i + 1})`);
    }
  }
  return tokens;
}

/** Parse a formula. Returns { ast, variables } or throws an Error with a readable message. */
export function parseFormula(text) {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("The formula is empty.");
  if (source.length > MAX_EXPRESSION_LENGTH)
    throw new Error(
      `The formula is too long (max ${MAX_EXPRESSION_LENGTH} characters).`,
    );
  const tokens = tokenize(source);
  let pos = 0;
  const used = new Set();
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(depth) {
    if (depth > 50) throw new Error("Too many nested brackets.");
    const t = next();
    if (!t) throw new Error("The formula ends too early.");
    if (t.type === "num") return { k: "num", v: t.value };
    if (t.type === "name") {
      if (!VARIABLE_NAMES.includes(t.value))
        throw new Error(`Unknown building block "${t.value}".`);
      used.add(t.value);
      return { k: "var", v: t.value };
    }
    if (t.value === "(") {
      const e = expr(depth + 1);
      const close = next();
      if (!close || close.value !== ")")
        throw new Error("A bracket is not closed.");
      return e;
    }
    if (t.value === "-") return { k: "neg", a: primary(depth + 1) };
    if (t.value === "+") return primary(depth + 1);
    throw new Error(`Unexpected "${t.value}" at position ${t.pos + 1}.`);
  }
  function term(depth) {
    let left = primary(depth);
    while (peek() && (peek().value === "*" || peek().value === "/")) {
      const op = next().value;
      left = { k: op, a: left, b: primary(depth) };
    }
    return left;
  }
  function expr(depth = 0) {
    let left = term(depth);
    while (peek() && (peek().value === "+" || peek().value === "-")) {
      const op = next().value;
      left = { k: op, a: left, b: term(depth) };
    }
    return left;
  }

  const ast = expr();
  if (pos < tokens.length) {
    const t = tokens[pos];
    throw new Error(`Unexpected "${t.value}" at position ${t.pos + 1}.`);
  }
  return { ast, variables: [...used] };
}

function evalNode(n, vars) {
  switch (n.k) {
    case "num":
      return n.v;
    case "var": {
      const v = Number(vars[n.v] ?? 0);
      return Number.isFinite(v) ? v : 0;
    }
    case "neg":
      return -evalNode(n.a, vars);
    case "+":
      return evalNode(n.a, vars) + evalNode(n.b, vars);
    case "-":
      return evalNode(n.a, vars) - evalNode(n.b, vars);
    case "*":
      return evalNode(n.a, vars) * evalNode(n.b, vars);
    case "/": {
      const d = evalNode(n.b, vars);
      if (d === 0) throw new Error("Division by zero.");
      return evalNode(n.a, vars) / d;
    }
    default:
      throw new Error("Invalid formula.");
  }
}

/** Evaluate a parsed formula (or formula text). Missing building blocks count as 0. */
export function evaluateFormula(formula, vars) {
  const { ast } = typeof formula === "string" ? parseFormula(formula) : formula;
  const result = evalNode(ast, vars);
  if (!Number.isFinite(result))
    throw new Error("The formula gives an invalid number.");
  return result;
}

/** { ok: true } or { ok: false, error } — for the editor. */
export function validateFormula(text) {
  try {
    const parsed = parseFormula(text);
    if (!parsed.variables.includes("weight"))
      return { ok: false, error: "The formula must use weight." };
    if (!parsed.variables.includes("metal_price"))
      return { ok: false, error: "The formula must use metal_price." };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// VAT (added after the formula)
// ---------------------------------------------------------------------------

/**
 * vat: { enabled, pct, basis: "workmanship" | "total" }
 * workmanship = making × weight + making % of the metal value.
 * Returns the VAT amount (0 when disabled or blocked).
 */
export function vatAmount(preVat, vars, vat) {
  if (!vat?.enabled) return 0;
  const pct = Number(vat.pct) || 0;
  if (pct <= 0) return 0;
  if (vat.basis === "workmanship") {
    const w = Number(vars.weight) || 0;
    const workmanship =
      (Number(vars.making) || 0) * w +
      ((Number(vars.metal_price) || 0) * w * (Number(vars.making_pct) || 0)) /
        100;
    return Math.max(0, workmanship) * (pct / 100);
  }
  return Math.max(0, preVat) * (pct / 100);
}
