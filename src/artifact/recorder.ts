import type { DiscoveryResult, DiscoveryTraceStep } from "../agent/discoveryLoop.js";
import type {
  CapabilityArtifact,
  Step,
  InputParam,
  OutputParam,
  Checkpoint,
  ErrorHandler,
} from "./schema.js";
import { CapabilityArtifactSchema } from "./schema.js";
import { classifyActionRisk } from "../safety/riskClassifier.js";

export interface RecordArtifactOptions {
  id: string;
  name: string;
  version: string;
  description: string;
  app: string;
  baseUrl: string;
  runId: string;
  discoveredBy: string;
  /** Literal values observed in the trace that should be templated as inputs, e.g. { "10001": "memberId" }. */
  parameterize: Record<string, string>;
  inputs: InputParam[];
  outputs: OutputParam[];
  successCheckpoint: Checkpoint;
  /** Hand-authored on top of the single recorded run: a lone successful trace can't itself reveal every
   *  runtime error branch, so the artifact's error taxonomy is reviewed/extended by whoever promotes the
   *  recording to a production capability. See REPORT.md, Determinism & error handling. */
  errorHandlers: ErrorHandler[];
  maxRiskLevel?: "safe" | "risky";
}

function templatize(value: string | undefined, parameterize: Record<string, string>): { value?: string; inputRef?: string } {
  if (value === undefined) return {};
  if (parameterize[value]) return { inputRef: parameterize[value] };
  return { value };
}

export function recordArtifact(discovery: DiscoveryResult, opts: RecordArtifactOptions): CapabilityArtifact {
  const steps: Step[] = discovery.trace.map((t: DiscoveryTraceStep, idx: number) => {
    const locators = [];
    // For extract steps, the structural (label-anchored) locator is value-independent and
    // must be tried first; the role/name locator would only match this exact run's data.
    if (t.structuralLocatorCss) locators.push({ strategy: "css" as const, value: t.structuralLocatorCss });
    if (t.resolvedLocator) locators.push({ strategy: "role" as const, role: t.resolvedLocator.role, name: t.resolvedLocator.name });
    const { value, inputRef } = templatize(t.value, opts.parameterize);
    const riskLevel = t.resolvedLocator ? classifyActionRisk(t.action, t.resolvedLocator.name) : "safe";
    const step: Step = {
      id: `s${idx + 1}`,
      action: t.action,
      locators,
      value,
      inputRef,
      outputRef: t.outputName,
      riskLevel,
    };
    return step;
  });

  const artifact: CapabilityArtifact = {
    schemaVersion: "1.0",
    id: opts.id,
    name: opts.name,
    version: opts.version,
    description: opts.description,
    target: { app: opts.app, baseUrl: opts.baseUrl },
    inputs: opts.inputs,
    outputs: opts.outputs,
    steps,
    successCheckpoint: opts.successCheckpoint,
    errorHandlers: opts.errorHandlers,
    policy: { allowlistRef: "default", maxRiskLevel: opts.maxRiskLevel ?? "safe" },
    provenance: {
      createdFromRunId: opts.runId,
      createdAt: new Date().toISOString(),
      discoveredBy: opts.discoveredBy,
    },
  };

  return CapabilityArtifactSchema.parse(artifact);
}
