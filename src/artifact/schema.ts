import { z } from "zod";

/**
 * Capability Artifact v1 — the reusable, reviewable, typed contract an AI
 * agent invokes in production. Decoupled from the raw LLM transcript
 * (which lives only in /evidence for a discovery run) so the artifact
 * itself stays small, stable, and reviewable by a human.
 */

export const LocatorSchema = z.object({
  strategy: z.enum(["role", "text", "css"]),
  role: z.string().optional(), // for strategy "role"
  name: z.string().optional(), // accessible name, for strategy "role"/"text"
  value: z.string().optional(), // for strategy "css" (selector) or "text" (exact text)
});
export type Locator = z.infer<typeof LocatorSchema>;

export const CheckpointSchema = z.object({
  type: z.enum(["urlMatches", "elementVisible", "textPresent"]),
  pattern: z.string().optional(), // for urlMatches (substring or regex source)
  locator: LocatorSchema.optional(), // for elementVisible
  text: z.string().optional(), // for textPresent
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const ActionTypeSchema = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "extract",
  "waitFor",
]);

export const StepSchema = z.object({
  id: z.string(),
  action: ActionTypeSchema,
  // Ranked candidate locators; replay tries them in order and records which resolved.
  locators: z.array(LocatorSchema).default([]),
  // Literal value (navigate URL, type text, select option) OR a reference to an input param name.
  value: z.string().optional(),
  inputRef: z.string().optional(),
  // For "extract" steps: which output param this step's read value feeds.
  outputRef: z.string().optional(),
  checkpoint: CheckpointSchema.optional(),
  riskLevel: z.enum(["safe", "risky"]).default("safe"),
});
export type Step = z.infer<typeof StepSchema>;

export const InputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().default(true),
  description: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
});
export type OutputParam = z.infer<typeof OutputParamSchema>;

export const ErrorHandlerSchema = z.object({
  code: z.string(), // machine-readable outcome code, e.g. "member_not_found"
  message: z.string(),
  condition: CheckpointSchema, // reuse checkpoint shape to describe "how do we detect this state"
  outcome: z.enum(["business_outcome", "recoverable", "hard_failure", "escalate"]),
  // For "recoverable": what to do before re-checking the primary checkpoint.
  recovery: z.enum(["retry", "dismiss", "none"]).default("none"),
  maxRetries: z.number().int().min(0).max(5).default(0),
});
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  version: z.string(), // semver of this artifact, independent of schemaVersion
  description: z.string(),

  target: z.object({
    app: z.string(), // logical app name, e.g. "meridian-core-banking"
    baseUrl: z.string(),
    tenantHint: z.string().optional(), // for future multi-tenant specialization; unused in v1
  }),

  inputs: z.array(InputParamSchema),
  outputs: z.array(OutputParamSchema),
  steps: z.array(StepSchema),

  successCheckpoint: CheckpointSchema,
  errorHandlers: z.array(ErrorHandlerSchema).default([]),

  policy: z.object({
    allowlistRef: z.string().default("default"),
    maxRiskLevel: z.enum(["safe", "risky"]).default("safe"),
  }),

  provenance: z.object({
    createdFromRunId: z.string(),
    createdAt: z.string(), // ISO timestamp
    discoveredBy: z.string(), // model id used during discovery
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
