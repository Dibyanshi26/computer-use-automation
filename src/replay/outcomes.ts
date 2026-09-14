export interface DebugInfo {
  step: string;
  expected: string;
  observed: string;
  screenshotPath?: string;
}

export type ReplayOutcome =
  | { status: "success"; outputs: Record<string, unknown> }
  // screenshotPath: the page state the moment the handler's condition matched, so a caller can
  // see what this business outcome was derived from without re-running the capability.
  | { status: "business_outcome"; code: string; message: string; screenshotPath: string }
  | { status: "escalated"; reason: string; resumedBy?: string; resumeNote?: string; outputs?: Record<string, unknown> }
  | { status: "hard_failure"; message: string; debug: DebugInfo };
