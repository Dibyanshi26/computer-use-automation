import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AllowlistConfig {
  allowedBaseUrls: string[];
  allowedRoutePatterns: string[];
  allowedActionTypes: string[];
  blockedActionNamePatterns: string[];
}

let cached: AllowlistConfig | null = null;

export function loadAllowlist(configPath?: string): AllowlistConfig {
  if (cached && !configPath) return cached;
  const p = configPath ?? path.join(__dirname, "..", "config", "allowlist.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const config: AllowlistConfig = {
    allowedBaseUrls: raw.allowedBaseUrls,
    allowedRoutePatterns: raw.allowedRoutePatterns,
    allowedActionTypes: raw.allowedActionTypes,
    blockedActionNamePatterns: raw.blockedActionNamePatterns,
  };
  if (!configPath) cached = config;
  return config;
}

export class GuardrailViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailViolation";
  }
}

/** Throws GuardrailViolation if the URL's origin isn't an allowlisted base URL. */
export function assertOriginAllowed(url: string, config: AllowlistConfig = loadAllowlist()): void {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}`;
  if (!config.allowedBaseUrls.includes(base)) {
    throw new GuardrailViolation(`URL base "${base}" is not in the allowlist.`);
  }
}

/** Throws GuardrailViolation if a navigation target isn't on the allowlist (origin AND route). */
export function assertUrlAllowed(url: string, config: AllowlistConfig = loadAllowlist()): void {
  assertOriginAllowed(url, config);
  const u = new URL(url);
  const matches = config.allowedRoutePatterns.some((pattern) => new RegExp(pattern).test(u.pathname));
  if (!matches) {
    throw new GuardrailViolation(`Route "${u.pathname}" does not match any allowed route pattern.`);
  }
}

/** Throws GuardrailViolation if the action type itself isn't permitted. */
export function assertActionTypeAllowed(actionType: string, config: AllowlistConfig = loadAllowlist()): void {
  if (!config.allowedActionTypes.includes(actionType)) {
    throw new GuardrailViolation(`Action type "${actionType}" is not in the allowlist.`);
  }
}

/** True if the target element's accessible name matches a blocked pattern (e.g. "delete", "wire transfer"). */
export function isBlockedByName(elementName: string, config: AllowlistConfig = loadAllowlist()): boolean {
  const lower = elementName.toLowerCase();
  return config.blockedActionNamePatterns.some((p) => lower.includes(p.toLowerCase()));
}
