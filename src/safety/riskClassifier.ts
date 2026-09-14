/**
 * Classifies an action as "safe" (read-only or trivially reversible: search,
 * navigate, view, cancel/back) or "risky" (creates/mutates state, or is
 * outright irreversible: confirm/submit/override/open account). Risky
 * actions are handled conservatively: the discovery agent may observe the
 * control and describe it, but it is blocked from clicking it unless the
 * capability's policy explicitly raises maxRiskLevel to "risky" (see
 * REPORT.md, Safety). This is why our example capabilities stop at a
 * confirmation screen rather than submitting it.
 */
const RISKY_NAME_PATTERNS = [
  "confirm",
  "submit",
  "open account",
  "override",
  "approve",
  "delete",
  "close",
  "transfer",
  "withdraw",
];

export type RiskLevel = "safe" | "risky";

export function classifyActionRisk(actionType: string, elementName: string): RiskLevel {
  if (actionType === "navigate" || actionType === "extract" || actionType === "waitFor") return "safe";
  const lower = elementName.toLowerCase();
  return RISKY_NAME_PATTERNS.some((p) => lower.includes(p)) ? "risky" : "safe";
}
