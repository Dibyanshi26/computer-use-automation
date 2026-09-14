import type { Page } from "playwright";
import type { Checkpoint } from "../artifact/schema.js";

export async function checkCondition(page: Page, cp: Checkpoint, timeoutMs = 3000): Promise<boolean> {
  try {
    if (cp.type === "urlMatches" && cp.pattern) {
      if (timeoutMs > 0) {
        await page.waitForURL((u) => u.toString().includes(cp.pattern!), { timeout: timeoutMs }).catch(() => {});
      }
      return page.url().includes(cp.pattern);
    }
    if (cp.type === "elementVisible" && cp.locator) {
      const loc = cp.locator;
      let candidate;
      if (loc.strategy === "role" && loc.role) {
        candidate = page.getByRole(loc.role as any, { name: loc.name, exact: true }).first();
      } else if (loc.strategy === "text") {
        candidate = page.getByText(loc.value ?? loc.name ?? "", { exact: false }).first();
      } else if (loc.strategy === "css" && loc.value) {
        candidate = page.locator(loc.value).first();
      } else {
        return false;
      }
      await candidate.waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    }
    if (cp.type === "textPresent" && cp.text) {
      await page.getByText(cp.text, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
