export interface DebugInfo {
  step: string;
  expected: string;
  observed: string;
  screenshotPath?: string;
}

export type ReplayOutcome =
  | { status: "success"; outputs: Record<string, unknown> }
  | { status: "business_outcome"; code: string; message: string }
  | { status: "escalated"; reason: string; resumedBy?: string; resumeNote?: string; outputs?: Record<string, unknown> }
  | { status: "hard_failure"; message: string; debug: DebugInfo };
