import type { Page } from "playwright";
import type { CapabilityArtifact, ErrorHandler } from "../artifact/schema.js";
import type { ReplayOutcome, DebugInfo } from "./outcomes.js";
import { resolveStep } from "./locator.js";
import { checkCondition } from "./checkpoint.js";
import { assertUrlAllowed, assertOriginAllowed, assertActionTypeAllowed, GuardrailViolation } from "../safety/allowlist.js";
import type { RunLogger } from "../evidence/logger.js";
import type { ControlServer, InterventionRequest, ResumeSignal } from "../escalation/controlServer.js";

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, unknown>;
  page: Page;
  logger: RunLogger;
  runId: string;
  controlServer?: ControlServer;
  /** Stand-in for a human operator, used to produce reproducible escalation evidence. */
  autoResume?: (page: Page, intervention: InterventionRequest) => Promise<ResumeSignal>;
}

function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, unknown>): string | null {
  for (const param of artifact.inputs) {
    if (param.required && !(param.name in inputs)) {
      return `Missing required input "${param.name}".`;
    }
    if (param.name in inputs) {
      const v = inputs[param.name];
      const t = typeof v;
      if (param.type === "number" && t !== "number") return `Input "${param.name}" must be a number.`;
      if (param.type === "string" && t !== "string") return `Input "${param.name}" must be a string.`;
      if (param.type === "boolean" && t !== "boolean") return `Input "${param.name}" must be a boolean.`;
    }
  }
  return null;
}

async function debugSnapshot(page: Page, logger: RunLogger, label: string): Promise<string> {
  return logger.screenshot(page, label);
}

async function tryErrorHandlers(
  page: Page,
  handlers: ErrorHandler[],
  stepId: string,
  logger: RunLogger,
  runId: string,
  controlServer: ControlServer | undefined,
  autoResume: ReplayOptions["autoResume"],
  artifact: CapabilityArtifact
): Promise<ReplayOutcome | { retry: true } | null> {
  for (const handler of handlers) {
    const matched = await checkCondition(page, handler.condition, 1500);
    if (!matched) continue;

    logger.log("replay.error_handler_matched", { code: handler.code, outcome: handler.outcome, step: stepId });

    if (handler.outcome === "business_outcome") {
      return { status: "business_outcome", code: handler.code, message: handler.message };
    }
    if (handler.outcome === "hard_failure") {
      const screenshotPath = await debugSnapshot(page, logger, `hard-failure-${stepId}`);
      return {
        status: "hard_failure",
        message: handler.message,
        debug: { step: stepId, expected: JSON.stringify(handler.condition), observed: page.url(), screenshotPath },
      };
    }
    if (handler.outcome === "recoverable") {
      return { retry: true };
    }
    if (handler.outcome === "escalate") {
      if (!controlServer) {
        const screenshotPath = await debugSnapshot(page, logger, `escalation-unavailable-${stepId}`);
        return {
          status: "hard_failure",
          message: `Escalation required ("${handler.message}") but no control server is configured for this run.`,
          debug: { step: stepId, expected: handler.message, observed: page.url(), screenshotPath },
        };
      }
      const screenshotPath = await debugSnapshot(page, logger, `escalation-${stepId}`);
      logger.log("escalation.requested", { step: stepId, reason: handler.message });
      const interventionDetails: Omit<InterventionRequest, "createdAt"> = {
        runId,
        capability: artifact.name,
        goal: artifact.description,
        stepId,
        reason: handler.message,
        screenshotFile: `${logger.runDir}/${screenshotPath}`,
      };
      const resumePromise = controlServer.requestIntervention(interventionDetails);
      const resolution = autoResume
        ? await autoResume(page, { ...interventionDetails, createdAt: new Date().toISOString() })
        : await resumePromise;
      logger.log("escalation.resumed", { resumedBy: resolution.resumedBy, note: resolution.note });
      return { retry: true };
    }
  }
  return null;
}

export async function replay(opts: ReplayOptions): Promise<ReplayOutcome> {
  const { artifact, inputs, page, logger, runId } = opts;

  const inputError = validateInputs(artifact, inputs);
  if (inputError) {
    return { status: "hard_failure", message: inputError, debug: { step: "input-validation", expected: "valid inputs", observed: JSON.stringify(inputs) } };
  }

  try {
    assertOriginAllowed(artifact.target.baseUrl);
  } catch (err) {
    if (err instanceof GuardrailViolation) {
      return { status: "hard_failure", message: `Guardrail violation: ${err.message}`, debug: { step: "policy", expected: "allowlisted target", observed: artifact.target.baseUrl } };
    }
    throw err;
  }

  const outputs: Record<string, unknown> = {};

  for (const step of artifact.steps) {
    logger.log("replay.step_start", { stepId: step.id, action: step.action });

    const resolvedValue = step.inputRef ? inputs[step.inputRef] : step.value;

    let attempt = 0;
    // A flat retry cap covers both "recoverable" handlers (retry after a wait/dismiss) and
    // "escalate" handlers (retry once the human has resumed and changed the page state) --
    // termination is really driven by reaching a terminal outcome or a resolvable locator,
    // not by counting attempts, so this is a safety bound rather than a precise budget.
    const maxAttemptsForStep = artifact.errorHandlers.length > 0 ? 5 : 1;

    stepRetryLoop: while (attempt < maxAttemptsForStep) {
      attempt += 1;
      try {
        assertActionTypeAllowed(step.action);

        if (step.action === "navigate") {
          const url = String(resolvedValue);
          assertUrlAllowed(url);
          await page.goto(url, { waitUntil: "domcontentloaded" });
        } else {
          const resolved = await resolveStep(page, step.locators);
          if (!resolved) {
            const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact);
            if (outcome && "retry" in outcome) continue stepRetryLoop;
            if (outcome) return outcome;
            const screenshotPath = await debugSnapshot(page, logger, `hard-failure-${step.id}`);
            return {
              status: "hard_failure",
              message: `Could not resolve any locator for step "${step.id}".`,
              debug: { step: step.id, expected: JSON.stringify(step.locators), observed: `url=${page.url()}`, screenshotPath },
            };
          }

          if (step.riskLevel === "risky" && artifact.policy.maxRiskLevel !== "risky") {
            const screenshotPath = await debugSnapshot(page, logger, `policy-escalation-${step.id}`);
            if (!opts.controlServer) {
              return {
                status: "hard_failure",
                message: `Step "${step.id}" is risky/irreversible and exceeds this capability's policy (maxRiskLevel=${artifact.policy.maxRiskLevel}); no control server configured.`,
                debug: { step: step.id, expected: "policy allows this action", observed: "risky action blocked", screenshotPath },
              };
            }
            const interventionDetails: Omit<InterventionRequest, "createdAt"> = {
              runId,
              capability: artifact.name,
              goal: artifact.description,
              stepId: step.id,
              reason: `Step exceeds policy: risky/irreversible action blocked pending human approval.`,
              screenshotFile: `${logger.runDir}/${screenshotPath}`,
            };
            logger.log("escalation.requested", { step: step.id, reason: interventionDetails.reason });
            const resumePromise = opts.controlServer.requestIntervention(interventionDetails);
            const resolution = opts.autoResume
              ? await opts.autoResume(page, { ...interventionDetails, createdAt: new Date().toISOString() })
              : await resumePromise;
            logger.log("escalation.resumed", { resumedBy: resolution.resumedBy, note: resolution.note });
            // Risky/irreversible actions are never executed by the automation itself (see
            // riskClassifier.ts): the human performs the click live during the handoff, so we
            // move on to this step's checkpoint rather than re-attempting the action.
            break stepRetryLoop;
          }

          if (step.action === "click") {
            await resolved.locator.click();
            await page.waitForLoadState("domcontentloaded").catch(() => {});
          } else if (step.action === "type") {
            await resolved.locator.fill(String(resolvedValue ?? ""));
          } else if (step.action === "select") {
            await resolved.locator.selectOption({ label: String(resolvedValue ?? "") }).catch(() => resolved.locator.selectOption(String(resolvedValue ?? "")));
          } else if (step.action === "extract" && step.outputRef) {
            const value = (await resolved.locator.innerText().catch(() => "")).trim();
            outputs[step.outputRef] = value;
          }
          logger.log("replay.locator_resolved", { stepId: step.id, strategy: resolved.strategyUsed });
        }

        if (step.checkpoint) {
          const ok = await checkCondition(page, step.checkpoint);
          if (!ok) {
            const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact);
            if (outcome && "retry" in outcome) continue stepRetryLoop;
            if (outcome) return outcome;
            const screenshotPath = await debugSnapshot(page, logger, `hard-failure-checkpoint-${step.id}`);
            return {
              status: "hard_failure",
              message: `Checkpoint for step "${step.id}" was not met.`,
              debug: { step: step.id, expected: JSON.stringify(step.checkpoint), observed: `url=${page.url()}`, screenshotPath },
            };
          }
        }

        break stepRetryLoop;
      } catch (err) {
        if (err instanceof GuardrailViolation) {
          return { status: "hard_failure", message: `Guardrail violation: ${err.message}`, debug: { step: step.id, expected: "allowlisted action", observed: err.message } };
        }
        const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact);
        if (outcome && "retry" in outcome) continue stepRetryLoop;
        if (outcome) return outcome;
        const screenshotPath = await debugSnapshot(page, logger, `hard-failure-exception-${step.id}`);
        return {
          status: "hard_failure",
          message: `Unhandled error on step "${step.id}": ${(err as Error).message}`,
          debug: { step: step.id, expected: "action to succeed", observed: (err as Error).message, screenshotPath },
        };
      }
    }

    logger.log("replay.step_done", { stepId: step.id });
  }

  const finalOk = await checkCondition(page, artifact.successCheckpoint);
  if (!finalOk) {
    const outcome = await tryErrorHandlers(page, artifact.errorHandlers, "success-checkpoint", logger, runId, opts.controlServer, opts.autoResume, artifact);
    if (outcome && !("retry" in outcome)) return outcome;
    const screenshotPath = await debugSnapshot(page, logger, "hard-failure-final-checkpoint");
    return {
      status: "hard_failure",
      message: "Final success checkpoint was not reached.",
      debug: { step: "success-checkpoint", expected: JSON.stringify(artifact.successCheckpoint), observed: `url=${page.url()}`, screenshotPath },
    };
  }

  return { status: "success", outputs };
}
