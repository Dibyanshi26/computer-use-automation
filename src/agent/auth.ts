import type { Page } from "playwright";

/**
 * Authentication is deliberately kept OUT of the recorded capability
 * artifact: it runs once, out of band, using env-provided demo
 * credentials, before either discovery or replay begins operating on a
 * capability. This means no credential ever enters the LLM conversation,
 * the trace, or the saved artifact -- only the resulting session cookie
 * (held by the live Page) does. See REPORT.md, Safety.
 */
export async function login(page: Page, baseUrl: string): Promise<void> {
  const username = process.env.TELLER_USERNAME ?? "demo-teller";
  const password = process.env.TELLER_PASSWORD ?? "demo-pass";
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.waitForURL((u) => u.toString().includes("/search"));
}
