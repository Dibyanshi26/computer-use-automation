export interface DebugInfo {
  step: string;
  expected: string;
  observed: string;
  screenshotPath?: string;
}

export type ReplayOutcome =
  // escalated: whether any step in this run required a human handoff. A capability can succeed
  // cleanly or succeed only because a human intervened -- those are different things for a
  // caller to know, even though both return status "success". There is deliberately no separate
  // terminal "escalated" status: escalation is a means to reaching success or a business outcome,
  // not an outcome class of its own (a run that escalates and then hits a business outcome, or
  // fails anyway, reports that -- with escalated: true on the way there where it can attach).
  | { status: "success"; outputs: Record<string, unknown>; escalated: boolean }
  // screenshotPath: the page state the moment the handler's condition matched, so a caller can
  // see what this business outcome was derived from without re-running the capability.
  | { status: "business_outcome"; code: string; message: string; screenshotPath: string }
  | { status: "hard_failure"; message: string; debug: DebugInfo };
