// Cards for the Pricing page: formula, making charges, optional costs, VAT, rules.
import { useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  InlineGrid,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { PURITIES, priceWithFormula, purityLabel } from "../lib/pricing";
import {
  TEMPLATE_BY_ID,
  VARIABLES,
  parseFormula,
  validateFormula,
} from "../lib/formula";
import { useShop } from "./ui";

export const activeFormulaOf = (settings) =>
  settings.formulas.find((f) => f.id === settings.activeFormulaId) ||
  settings.formulas[0];

export function FormulaCard({ settings, setSettings, prices, taxesIncluded }) {
  const { money, currency } = useShop();
  const [newName, setNewName] = useState("");
  const [blocksOpen, setBlocksOpen] = useState(false);
  const formula = activeFormulaOf(settings);
  const template = TEMPLATE_BY_ID[formula.templateId];
  const check = validateFormula(formula.expression);
  const vatLocked = taxesIncluded === false;

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const setExpression = (expression) =>
    update({
      formulas: settings.formulas.map((f) =>
        f.id === formula.id ? { ...f, expression } : f,
      ),
    });
  const choose = (id) => {
    const t = TEMPLATE_BY_ID[id];
    setSettings((s) => ({
      ...s,
      activeFormulaId: id,
      vat: t?.suggestVatBasis ? { ...s.vat, basis: t.suggestVatBasis } : s.vat,
    }));
  };
  const saveAsNew = () => {
    const id = `custom-${Date.now().toString(36)}`;
    update({
      formulas: [
        ...settings.formulas,
        {
          id,
          name: newName.trim() || "My formula",
          expression: formula.expression,
        },
      ],
      activeFormulaId: id,
    });
    setNewName("");
  };
  const remove = () =>
    update({
      formulas: settings.formulas.filter((f) => f.id !== formula.id),
      activeFormulaId: "classic",
    });

  // Live example: 21k (or 24k), 5 g, local workmanship.
  const exampleKey = prices.byKarat["21"]?.price > 0 ? "21" : "24";
  const exampleVars = {
    metal_price: prices.byKarat[exampleKey]?.price || 0,
    weight: 5,
    making: settings.making[exampleKey]?.local || 0,
    making_pct: settings.makingPct,
    wastage_pct: settings.wastagePct,
    stone_cost: 0,
    fixed_fee: settings.fixedFee,
    profit_pct: settings.profitPct,
    discount: settings.discountPerPiece,
  };
  let example = null;
  let exampleError = null;
  if (check.ok && exampleVars.metal_price > 0) {
    try {
      example = priceWithFormula(
        parseFormula(formula.expression),
        exampleVars,
        settings,
        !vatLocked,
      );
    } catch (error) {
      exampleError = error.message;
    }
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Price formula
          </Text>
          <Text as="p" tone="subdued">
            Pick a ready-made formula or write your own with the building
            blocks. Switching formulas keeps all your values.
          </Text>
        </BlockStack>

        <Select
          label="Formula"
          options={settings.formulas.map((f) => ({
            label: f.templateId ? f.name : `${f.name} (yours)`,
            value: f.id,
          }))}
          value={formula.id}
          onChange={choose}
        />
        {template && (
          <Text as="p" variant="bodySm" tone="subdued">
            {template.description}
          </Text>
        )}

        <TextField
          label="Formula (before VAT, then rounded)"
          value={formula.expression}
          onChange={setExpression}
          multiline={2}
          monospaced
          autoComplete="off"
          error={check.ok ? undefined : check.error}
        />
        <InlineStack gap="200" wrap>
          {VARIABLES.map((v) => (
            <Button
              key={v.name}
              size="slim"
              onClick={() =>
                setExpression(`${formula.expression.trimEnd()} ${v.name}`)
              }
              accessibilityLabel={`Insert ${v.label}`}
            >
              {v.name}
            </Button>
          ))}
        </InlineStack>

        <InlineStack align="start">
          <Button variant="plain" onClick={() => setBlocksOpen((o) => !o)}>
            {blocksOpen
              ? "Hide what the building blocks mean"
              : "What do the building blocks mean?"}
          </Button>
        </InlineStack>
        <Collapsible open={blocksOpen} id="gpe-blocks">
          <div className="gpe-scroll">
            <table className="gpe-matrix" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>Building block</th>
                  <th>Means</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {VARIABLES.map((v) => (
                  <tr key={v.name}>
                    <td>
                      <code>{v.name}</code>
                    </td>
                    <td>{v.label}</td>
                    <td>{v.unit.replace("{currency}", currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>

        <InlineStack gap="200" blockAlign="end" wrap>
          {template && formula.expression !== template.expression && (
            <Button onClick={() => setExpression(template.expression)}>
              Reset to original
            </Button>
          )}
          {!template && (
            <Button tone="critical" variant="plain" onClick={remove}>
              Delete this formula
            </Button>
          )}
          <div style={{ minWidth: 200 }}>
            <TextField
              label="Save a copy as"
              labelHidden
              placeholder="Name for a new formula"
              value={newName}
              onChange={setNewName}
              autoComplete="off"
              connectedRight={
                <Button onClick={saveAsNew} disabled={!check.ok}>
                  Save as new
                </Button>
              }
            />
          </div>
        </InlineStack>

        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          {exampleError ? (
            <Text as="p" tone="critical">
              Example failed: {exampleError}
            </Text>
          ) : example ? (
            <Text as="p" variant="bodySm">
              Example: {purityLabel(exampleKey)}, 5 g, local making charge →
              before VAT {money.format(example.preVat)}
              {example.vat > 0
                ? ` + VAT ${money.format(example.vat)}`
                : ""} = <strong>{money.format(example.price)}</strong>
            </Text>
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">
              The example appears when the formula is valid and a price is
              available.
            </Text>
          )}
        </Box>
      </BlockStack>
    </Card>
  );
}

export function MakingChargesCard({ settings, setSettings }) {
  const { currency } = useShop();
  const setMaking = (k, origin, value) =>
    setSettings((s) => ({
      ...s,
      making: { ...s.making, [k]: { ...s.making[k], [origin]: value } },
    }));
  const list = PURITIES.filter((p) => settings.includeKarats.includes(p.key));
  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Making charges
          </Text>
          <Text as="p" tone="subdued">
            Workmanship in {currency} per gram, for local and imported pieces. A
            product metafield named <code>making_charge</code> overrides it for
            that product.
          </Text>
        </BlockStack>
        {list.length ? (
          <div className="gpe-scroll">
            <table className="gpe-matrix">
              <thead>
                <tr>
                  <th>Purity</th>
                  <th>Local ({currency}/g)</th>
                  <th>Imported ({currency}/g)</th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ key: k, label }) => (
                  <tr key={k}>
                    <td>
                      <Text as="span" fontWeight="semibold">
                        {label}
                      </Text>
                    </td>
                    <td>
                      <TextField
                        label={`${label} local workmanship`}
                        labelHidden
                        type="number"
                        value={String(settings.making[k].local)}
                        onChange={(v) => setMaking(k, "local", v)}
                        autoComplete="off"
                      />
                    </td>
                    <td>
                      <TextField
                        label={`${label} imported workmanship`}
                        labelHidden
                        type="number"
                        value={String(settings.making[k].imported)}
                        onChange={(v) => setMaking(k, "imported", v)}
                        autoComplete="off"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Text as="p" tone="subdued">
            No karats are switched on. Choose them in Settings.
          </Text>
        )}
        <Text as="p" variant="bodySm" tone="subdued">
          Only the karats you update are listed. Switch karats on or off in
          Settings.
        </Text>
      </BlockStack>
    </Card>
  );
}

export function OptionalCostsCard({ settings, set }) {
  const { currency } = useShop();
  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Optional costs
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Shop-wide values. A product metafield with the same name (
            <code>wastage_pct</code>, <code>making_pct</code>,{" "}
            <code>fixed_fee</code>, <code>profit_pct</code>) overrides them for
            that product. Stone / diamond cost is set per product in a{" "}
            <code>stone_cost</code> metafield ({currency}, total per piece).
            Each cost is only used if your formula includes it.
          </Text>
        </BlockStack>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="Wastage"
            type="number"
            suffix="% of metal"
            value={String(settings.wastagePct)}
            onChange={(v) => set("wastagePct", v)}
            autoComplete="off"
          />
          <TextField
            label="Making charge %"
            type="number"
            suffix="% of metal value"
            value={String(settings.makingPct)}
            onChange={(v) => set("makingPct", v)}
            autoComplete="off"
          />
          <TextField
            label="Fixed fee"
            type="number"
            prefix={currency}
            suffix="per piece"
            value={String(settings.fixedFee)}
            onChange={(v) => set("fixedFee", v)}
            autoComplete="off"
          />
          <TextField
            label="Profit"
            type="number"
            suffix="%"
            value={String(settings.profitPct)}
            onChange={(v) => set("profitPct", v)}
            autoComplete="off"
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

export function VatCard({ settings, set, taxesIncluded }) {
  const vatLocked = taxesIncluded === false;
  const setVat = (patch) => set("vat", { ...settings.vat, ...patch });
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          VAT
        </Text>
        {vatLocked ? (
          <Banner tone="info">
            <p>
              Your Shopify store adds tax at checkout (Settings → Taxes and
              duties → &quot;Include sales tax in product price&quot; is off).
              Adding VAT here too would charge it twice, so VAT is switched off
              in the app. Turn that Shopify setting on if your prices should
              include VAT.
            </p>
          </Banner>
        ) : taxesIncluded === null ? (
          <Banner tone="warning">
            <p>
              We couldn&apos;t read your Shopify tax setting. Only add VAT here
              if your Shopify prices include tax.
            </p>
          </Banner>
        ) : null}
        <Checkbox
          label="Add VAT to prices"
          checked={settings.vat.enabled && !vatLocked}
          disabled={vatLocked}
          onChange={(on) => setVat({ enabled: on })}
          helpText="Added after the formula, before rounding."
        />
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="VAT rate"
            type="number"
            suffix="%"
            value={String(settings.vat.pct)}
            onChange={(v) => setVat({ pct: v })}
            disabled={vatLocked || !settings.vat.enabled}
            autoComplete="off"
          />
          <Select
            label="VAT is charged on"
            options={[
              { label: "The total price", value: "total" },
              { label: "Workmanship only", value: "workmanship" },
            ]}
            value={settings.vat.basis}
            onChange={(v) => setVat({ basis: v })}
            disabled={vatLocked || !settings.vat.enabled}
            helpText="Workmanship = making charge per gram × weight, plus any making charge %."
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

export function RulesCard({ settings, set }) {
  const { currency } = useShop();
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Discount and rounding
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="Discount per piece"
            type="number"
            prefix={currency}
            value={String(settings.discountPerPiece)}
            onChange={(v) => set("discountPerPiece", v)}
            helpText="Used by formulas that include discount."
            autoComplete="off"
          />
          <Select
            label="Round prices to"
            options={[
              { label: "No rounding", value: "0.01" },
              { label: `Nearest 1 ${currency}`, value: "1" },
              { label: `Nearest 5 ${currency}`, value: "5" },
              { label: `Nearest 10 ${currency}`, value: "10" },
              { label: `Nearest 50 ${currency}`, value: "50" },
              { label: `Nearest 100 ${currency}`, value: "100" },
            ]}
            value={settings.rounding}
            onChange={(v) => set("rounding", v)}
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}
