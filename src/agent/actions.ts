import type { Page } from "playwright";
import type { PerceivedNode } from "../perception/accessibilityTree.js";
import { assertActionTypeAllowed, assertUrlAllowed, isBlockedByName, GuardrailViolation } from "../safety/allowlist.js";
import { classifyActionRisk, type RiskLevel } from "../safety/riskClassifier.js";

export interface ResolvedLocatorInfo {
  role: string;
  name: string;
}

function resolveLocator(page: Page, node: PerceivedNode) {
  // getByRole + accessible name is the primary, most robust strategy: it
  // survives markup/CSS changes and is the same mental model as a screen
  // reader (and, on desktop, an OS accessibility API) would use.
  return page.getByRole(node.role as any, { name: node.name, exact: true }).first();
}

export interface ActionOutcome {
  ok: boolean;
  riskLevel: RiskLevel;
  blockedReason?: string;
  resolvedLocator?: ResolvedLocatorInfo;
  extractedValue?: string;
  /** For "extract": a structural, value-independent locator to prefer on replay (see below). */
  structuralLocatorCss?: string;
}

/**
 * A value cell's own accessible name IS the data we're extracting, so it varies every run
 * (a different member has a different balance) and can never be a safe replay locator. In our
 * label/value table markup the value is reliably the row's 2nd cell, so we anchor on the
 * adjacent, run-invariant label cell instead ("Checking Balance" -> its sibling cell) and use
 * that as the primary locator, falling back to the literal value match only as a last resort.
 *
 * `:has-text()` matches an element if the given text appears ANYWHERE in its own text content,
 * ancestors included -- so on a page whose chrome nests the real content several tables deep
 * (layout wrapper tables around a panel around the actual data table, all legitimate in a
 * legacy-app-style UI), a bare `tr:has-text("Checking Balance")` also matches every wrapper
 * <tr> between the label row and the document root, and unioning in `td:nth-of-type(2)` as a
 * descendant then matches every sibling row's 2nd cell within those wrappers too -- `.first()`
 * can land on a completely unrelated cell (verified: it landed on the Member ID cell instead of
 * the balance). `:not(:has(table))` excludes any <tr> that itself contains a nested table --
 * true of every layout-wrapper row, false of an actual leaf label/value row -- which keeps the
 * match to just the one row we mean regardless of how deep it's nested.
 */
async function computeRowLabelLocatorCss(locator: ReturnType<Page["getByRole"]>): Promise<string | null> {
  const label = await locator
    .evaluate((el: Element) => {
      const row = el.closest("tr");
      const firstCell = row?.querySelector("td, th");
      return firstCell?.textContent?.trim() ?? null;
    })
    .catch(() => null);
  if (!label) return null;
  const escaped = label.replace(/"/g, '\\"');
  return `tr:has-text("${escaped}"):not(:has(table)) td:nth-of-type(2)`;
}

export interface ActionContext {
  /** true = actually block risky actions (discovery/replay default policy). */
  enforceRiskBlock: boolean;
}

export async function actNavigate(page: Page, url: string): Promise<ActionOutcome> {
  assertActionTypeAllowed("navigate");
  assertUrlAllowed(url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { ok: true, riskLevel: "safe" };
}

function checkNodeGuardrails(actionType: string, node: PerceivedNode, ctx: ActionContext): ActionOutcome | null {
  assertActionTypeAllowed(actionType);
  if (isBlockedByName(node.name)) {
    return { ok: false, riskLevel: "risky", blockedReason: `"${node.name}" matches a blocked-action name pattern.` };
  }
  const riskLevel = classifyActionRisk(actionType, node.name);
  if (riskLevel === "risky" && ctx.enforceRiskBlock) {
    return {
      ok: false,
      riskLevel,
      blockedReason: `"${node.name}" is classified as a risky/irreversible action and is blocked by policy (maxRiskLevel=safe).`,
    };
  }
  return null;
}

export async function actClick(page: Page, node: PerceivedNode, ctx: ActionContext): Promise<ActionOutcome> {
  const blocked = checkNodeGuardrails("click", node, ctx);
  if (blocked) return blocked;
  const locator = resolveLocator(page, node);
  await locator.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return { ok: true, riskLevel: classifyActionRisk("click", node.name), resolvedLocator: { role: node.role, name: node.name } };
}

export async function actType(page: Page, node: PerceivedNode, text: string, ctx: ActionContext): Promise<ActionOutcome> {
  const blocked = checkNodeGuardrails("type", node, ctx);
  if (blocked) return blocked;
  const locator = resolveLocator(page, node);
  await locator.fill(text);
  return { ok: true, riskLevel: "safe", resolvedLocator: { role: node.role, name: node.name } };
}

export async function actSelect(page: Page, node: PerceivedNode, option: string, ctx: ActionContext): Promise<ActionOutcome> {
  const blocked = checkNodeGuardrails("select", node, ctx);
  if (blocked) return blocked;
  const locator = resolveLocator(page, node);
  await locator.selectOption({ label: option }).catch(() => locator.selectOption(option));
  return { ok: true, riskLevel: "safe", resolvedLocator: { role: node.role, name: node.name } };
}

export async function actExtract(page: Page, node: PerceivedNode, ctx: ActionContext): Promise<ActionOutcome> {
  const blocked = checkNodeGuardrails("extract", node, ctx);
  if (blocked) return blocked;
  const locator = resolveLocator(page, node);
  const value = (await locator.innerText().catch(() => node.value ?? "")).trim();
  const structuralLocatorCss = node.role === "cell" ? await computeRowLabelLocatorCss(locator) : null;
  return {
    ok: true,
    riskLevel: "safe",
    resolvedLocator: { role: node.role, name: node.name },
    extractedValue: value,
    structuralLocatorCss: structuralLocatorCss ?? undefined,
  };
}

export { GuardrailViolation };
