import type { InputParam, OutputParam, Checkpoint, ErrorHandler } from "../artifact/schema.js";

/**
 * Everything the `run` CLI command needs to discover one capability, so that adding a second
 * (or Nth) discoverable capability means adding a spec here rather than duplicating cmdRun's
 * goal-building/parameterize/recordArtifact-options block per capability.
 */
export interface DiscoverySpec {
  id: string;
  name: string;
  description: string;
  app: string;
  /** Path (relative to the mock app's base URL) the discovery loop should start on. */
  startPath: string;
  /** Params the CLI must receive via --input, in the order they should be validated. */
  inputs: InputParam[];
  /** Static output declarations, or derive them from what the model actually reported in finish(). */
  outputs: OutputParam[] | ((discoveryOutputs: Record<string, unknown>) => OutputParam[]);
  buildGoal(params: Record<string, string>): string;
  /** Literal values (as typed/entered during the run) that should become templated inputRefs. */
  parameterize(params: Record<string, string>): Record<string, string>;
  successCheckpoint: Checkpoint;
  errorHandlers: ErrorHandler[];
  maxRiskLevel?: "safe" | "risky";
}

const memberNotFoundHandler: ErrorHandler = {
  code: "member_not_found",
  message: "No member found for the given search.",
  condition: { type: "textPresent", text: "No member found" },
  outcome: "business_outcome",
  recovery: "none",
  maxRetries: 0,
};

const lookupMemberBalance: DiscoverySpec = {
  id: "lookup-member-balance",
  name: "Look Up Member Balance",
  description: "Search for a member by ID and read their current checking and savings balance.",
  app: "meridian-core-banking",
  startPath: "/search",
  inputs: [{ name: "memberId", type: "string", required: true, description: "Member ID to search for." }],
  outputs: (discoveryOutputs) =>
    Object.keys(discoveryOutputs)
      .filter((k) => k !== "businessOutcome")
      .map((name) => ({ name, type: "string", description: `Extracted value for ${name}.` })),
  buildGoal: (params) =>
    `Look up member ${params.memberId} and read their current checking and savings balance. ` +
    `Search using the member id field on /search, open the matching member's detail page, ` +
    `then call extract twice: once with outputName "checkingBalance" for the checking balance value, ` +
    `and once with outputName "savingsBalance" for the savings balance value. Then call finish with ` +
    `success=true and outputs containing both values. If no member is found, call finish with ` +
    `success=true and an outputs field "businessOutcome" describing that, since that is a legitimate result.`,
  parameterize: (params) => ({ [params.memberId]: "memberId" }),
  successCheckpoint: { type: "textPresent", text: "Checking Balance" },
  errorHandlers: [memberNotFoundHandler],
};

const openSubaccountDiscovered: DiscoverySpec = {
  id: "open-subaccount-discovered",
  name: "Open Sub-Account (to Confirmation) [discovered]",
  description: "Search for a member, open a new sub-account with the given type/deposit/nickname, and reach (but not submit) the confirmation screen.",
  app: "meridian-core-banking",
  startPath: "/search",
  inputs: [
    { name: "memberId", type: "string", required: true, description: "Member ID to search for and open a sub-account for." },
    { name: "depositAmount", type: "number", required: true, description: "Initial deposit amount in USD." },
    { name: "nickname", type: "string", required: true, description: "Nickname for the new sub-account." },
  ],
  outputs: [],
  buildGoal: (params) =>
    `Open a new sub-account for member ${params.memberId} and reach the confirmation screen -- ` +
    `do NOT click "Confirm & Open Account" or otherwise submit the confirmation; stopping at that ` +
    `screen is the goal, not completing it.\n` +
    `Steps: search for member ${params.memberId} on /search, open their detail page, choose ` +
    `"Open Sub-Account", leave the account type as "Standard Savings" (the default), type exactly ` +
    `${params.depositAmount} (digits only, no "$" and no decimals) into the initial deposit field, ` +
    `type exactly "${params.nickname}" into the nickname field, then continue to the confirmation screen.\n` +
    `The goal is achieved as soon as the confirmation screen is visible (it shows a review table and a ` +
    `"Confirm & Open Account" button) -- call finish with success=true at that point without clicking ` +
    `that button. If the deposit is rejected as too low, the member can't be found, or a supervisor/` +
    `manager-review interstitial blocks you, call finish with success=true and an outputs field ` +
    `"businessOutcome" describing what happened, since that is a legitimate result, not a failure.`,
  parameterize: (params) => ({
    [params.memberId]: "memberId",
    [params.depositAmount]: "depositAmount",
    [params.nickname]: "nickname",
  }),
  successCheckpoint: { type: "textPresent", text: "Confirm & Open Account" },
  errorHandlers: [memberNotFoundHandler],
};

export const DISCOVERY_SPECS: Record<string, DiscoverySpec> = {
  [lookupMemberBalance.id]: lookupMemberBalance,
  [openSubaccountDiscovered.id]: openSubaccountDiscovered,
};
