import type { Page, Locator as PwLocator } from "playwright";
import type { Locator } from "../artifact/schema.js";

export interface ResolvedLocator {
  locator: PwLocator;
  strategyUsed: Locator["strategy"];
  /** The specific candidate (role/name, text, or css) that resolved -- lets a caller inspect
   *  what actually matched live, e.g. to re-check the target's name against a blocklist
   *  independent of whatever riskLevel the artifact happens to declare for the step. */
  matchedLocator: Locator;
}

/**
 * Tries each ranked candidate locator in order (role+name, then text, then
 * raw css) and returns the first that resolves to a visible element within
 * a short timeout. Recording which strategy resolved is what lets a future
 * drift-detector flag "this artifact now depends on its 3rd-choice
 * fallback" before it breaks outright (see REPORT.md, Heterogeneity).
 */
export async function resolveStep(page: Page, locators: Locator[], timeoutMs = 3000): Promise<ResolvedLocator | null> {
  for (const loc of locators) {
    try {
      let candidate: PwLocator;
      if (loc.strategy === "role" && loc.role) {
        candidate = page.getByRole(loc.role as any, { name: loc.name, exact: true }).first();
      } else if (loc.strategy === "text" && (loc.value ?? loc.name)) {
        candidate = page.getByText(loc.value ?? loc.name ?? "", { exact: false }).first();
      } else if (loc.strategy === "css" && loc.value) {
        candidate = page.locator(loc.value).first();
      } else {
        continue;
      }
      await candidate.waitFor({ state: "visible", timeout: timeoutMs });
      return { locator: candidate, strategyUsed: loc.strategy, matchedLocator: loc };
    } catch {
      continue;
    }
  }
  return null;
}
