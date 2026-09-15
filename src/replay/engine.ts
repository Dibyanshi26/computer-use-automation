import type { Page } from "playwright";
import type { CapabilityArtifact, ErrorHandler } from "../artifact/schema.js";
import type { ReplayOutcome, DebugInfo } from "./outcomes.js";
import { resolveStep } from "./locator.js";
import { checkCondition } from "./checkpoint.js";
import { assertUrlAllowed, assertOriginAllowed, assertActionTypeAllowed, isBlockedByName, GuardrailViolation } from "../safety/allowlist.js";
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

/**
 * Raises the intervention and returns once control is back with automation -- via the real
 * operator console's POST /resume, or (if autoResume is set) the scripted stand-in. Both go
 * through ControlServer.resume() identically: the stand-in performs its action(s) on the live
 * page and then calls resume() itself rather than short-circuiting the handoff, so its clicks
 * pass through the same human.action recording and control.transferred logging a real operator's
 * would, and there is no second, shorter path back to automation.
 */
async function performHandoff(
  controlServer: ControlServer,
  page: Page,
  interventionDetails: Omit<InterventionRequest, "createdAt">,
  autoResume: ReplayOptions["autoResume"]
): Promise<ResumeSignal> {
  const resumePromise = controlServer.requestIntervention(page, interventionDetails);
  if (autoResume) {
    autoResume(page, { ...interventionDetails, createdAt: new Date().toISOString() }).then((resolution) =>
      controlServer.resume(resolution.resumedBy, resolution.note)
    );
  }
  return resumePromise;
}

const RECOVERABLE_RETRY_WAIT_MS = 1200;

/** e.g. "business-outcome-member_not_found-s4", "recovery-dismiss-s2", "escalation-s6". */
function screenshotLabelForHandler(handler: ErrorHandler, stepId: string): string {
  if (handler.outcome === "business_outcome") return `business-outcome-${handler.code}-${stepId}`;
  if (handler.outcome === "recoverable") return `recovery-${handler.recovery}-${stepId}`;
  if (handler.outcome === "escalate") return `escalation-${stepId}`;
  return `hard-failure-${stepId}`;
}

/** Signals a retry of the current step; `escalated` records whether that retry followed a human
 *  handoff (vs. a plain wait/dismiss) so the caller can thread it into the final outcome. */
type RetrySignal = { retry: true; escalated?: boolean };

async function tryErrorHandlers(
  page: Page,
  handlers: ErrorHandler[],
  stepId: string,
  logger: RunLogger,
  runId: string,
  controlServer: ControlServer | undefined,
  autoResume: ReplayOptions["autoResume"],
  artifact: CapabilityArtifact,
  handlerAttempts: Map<string, number>
): Promise<ReplayOutcome | RetrySignal | null> {
  for (const handler of handlers) {
    // Short and deliberate: this is "is this condition true right now", not "wait for it to
    // become true" (that's what resolveStep's own timeout, above, already did). A long timeout
    // here would let a time-sensitive condition (e.g. a page auto-recovering from a slow load)
    // slip past its window while we're still sequentially checking earlier, non-matching
    // handlers -- see the "slow load" handler and the note on handler ordering below.
    const matched = await checkCondition(page, handler.condition, 250);
    if (!matched) continue;

    // Captured once, immediately on match, before any recovery action or branch-specific logic
    // runs -- every branch below reuses this same path rather than taking its own screenshot.
    const screenshotPath = await debugSnapshot(page, logger, screenshotLabelForHandler(handler, stepId));
    logger.log("replay.error_handler_matched", { code: handler.code, outcome: handler.outcome, step: stepId, screenshotPath });

    if (handler.outcome === "business_outcome") {
      return { status: "business_outcome", code: handler.code, message: handler.message, screenshotPath };
    }
    if (handler.outcome === "hard_failure") {
      return {
        status: "hard_failure",
        message: handler.message,
        debug: { step: stepId, expected: JSON.stringify(handler.condition), observed: page.url(), screenshotPath },
      };
    }
    if (handler.outcome === "recoverable") {
      const used = handlerAttempts.get(handler.code) ?? 0;
      if (used >= handler.maxRetries) {
        return {
          status: "hard_failure",
          message: `Recoverable condition "${handler.code}" did not clear after ${handler.maxRetries} retr${handler.maxRetries === 1 ? "y" : "ies"}.`,
          debug: { step: stepId, expected: handler.message, observed: page.url(), screenshotPath },
        };
      }
      handlerAttempts.set(handler.code, used + 1);

      if (handler.recovery === "dismiss" && handler.dismissLocator) {
        const resolved = await resolveStep(page, [handler.dismissLocator], 2000);
        if (resolved) {
          logger.log("replay.recovery_dismiss", { code: handler.code, attempt: used + 1 });
          await resolved.locator.click();
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        } else {
          logger.log("replay.recovery_dismiss_locator_not_found", { code: handler.code });
        }
      } else if (handler.recovery === "retry") {
        logger.log("replay.recovery_wait_retry", { code: handler.code, attempt: used + 1, waitMs: RECOVERABLE_RETRY_WAIT_MS });
        await page.waitForTimeout(RECOVERABLE_RETRY_WAIT_MS);
      }
      return { retry: true };
    }
    if (handler.outcome === "escalate") {
      if (!controlServer) {
        return {
          status: "hard_failure",
          message: `Escalation required ("${handler.message}") but no control server is configured for this run.`,
          debug: { step: stepId, expected: handler.message, observed: page.url(), screenshotPath },
        };
      }
      logger.log("escalation.requested", { step: stepId, reason: handler.message });
      const interventionDetails: Omit<InterventionRequest, "createdAt"> = {
        runId,
        capability: artifact.name,
        goal: artifact.description,
        stepId,
        reason: handler.message,
        screenshotFile: `${logger.runDir}/${screenshotPath}`,
      };
      const resolution = await performHandoff(controlServer, page, interventionDetails, autoResume);
      logger.log("escalation.resumed", { resumedBy: resolution.resumedBy, note: resolution.note });
      return { retry: true, escalated: true };
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
  let escalated = false;

  for (const step of artifact.steps) {
    logger.log("replay.step_start", { stepId: step.id, action: step.action });

    const resolvedValue = step.inputRef ? inputs[step.inputRef] : step.value;

    let attempt = 0;
    // A flat retry cap covers both "recoverable" handlers (retry after a wait/dismiss) and
    // "escalate" handlers (retry once the human has resumed and changed the page state) --
    // termination is really driven by reaching a terminal outcome or a resolvable locator,
    // not by counting attempts, so this is a safety bound rather than a precise budget. Each
    // recoverable handler additionally enforces its own maxRetries via handlerAttempts below.
    const maxAttemptsForStep = artifact.errorHandlers.length > 0 ? 8 : 1;
    const handlerAttempts = new Map<string, number>();

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
            const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact, handlerAttempts);
            if (outcome && "retry" in outcome) {
              if (outcome.escalated) escalated = true;
              continue stepRetryLoop;
            }
            if (outcome) return outcome;
            const screenshotPath = await debugSnapshot(page, logger, `hard-failure-${step.id}`);
            return {
              status: "hard_failure",
              message: `Could not resolve any locator for step "${step.id}".`,
              debug: { step: step.id, expected: JSON.stringify(step.locators), observed: `url=${page.url()}`, screenshotPath },
            };
          }

          if (step.action === "click" || step.action === "type" || step.action === "select") {
            // Re-check the live target's name against the blocklist, independent of whatever
            // riskLevel the artifact declares -- riskLevel is data baked in at recording time and
            // can be wrong (hand-authored, or drifted); this reads what actually resolved on the
            // live page, mirroring the same check actions.ts already applies during discovery.
            const liveName = resolved.matchedLocator.name ?? resolved.matchedLocator.value ?? "";
            if (isBlockedByName(liveName)) {
              const screenshotPath = await debugSnapshot(page, logger, `blocklist-${step.id}`);
              return {
                status: "hard_failure",
                message: `Blocked: "${liveName}" matches a blocked-action name pattern; refusing to replay step "${step.id}" regardless of its declared riskLevel.`,
                debug: { step: step.id, expected: "not a blocklisted action", observed: liveName, screenshotPath },
              };
            }
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
            const resolution = await performHandoff(opts.controlServer, page, interventionDetails, opts.autoResume);
            logger.log("escalation.resumed", { resumedBy: resolution.resumedBy, note: resolution.note });
            escalated = true;
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
            const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact, handlerAttempts);
            if (outcome && "retry" in outcome) {
              if (outcome.escalated) escalated = true;
              continue stepRetryLoop;
            }
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
        const outcome = await tryErrorHandlers(page, artifact.errorHandlers, step.id, logger, runId, opts.controlServer, opts.autoResume, artifact, handlerAttempts);
        if (outcome && "retry" in outcome) {
          if (outcome.escalated) escalated = true;
          continue stepRetryLoop;
        }
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

  const finalHandlerAttempts = new Map<string, number>();
  const maxFinalAttempts = artifact.errorHandlers.length > 0 ? 8 : 1;
  let finalOk = await checkCondition(page, artifact.successCheckpoint);
  let finalAttempt = 0;
  while (!finalOk && finalAttempt < maxFinalAttempts) {
    finalAttempt += 1;
    const outcome = await tryErrorHandlers(
      page,
      artifact.errorHandlers,
      "success-checkpoint",
      logger,
      runId,
      opts.controlServer,
      opts.autoResume,
      artifact,
      finalHandlerAttempts
    );
    if (outcome && "retry" in outcome) {
      if (outcome.escalated) escalated = true;
      finalOk = await checkCondition(page, artifact.successCheckpoint);
      continue;
    }
    if (outcome) return outcome;
    break;
  }
  if (!finalOk) {
    const screenshotPath = await debugSnapshot(page, logger, "hard-failure-final-checkpoint");
    return {
      status: "hard_failure",
      message: "Final success checkpoint was not reached.",
      debug: { step: "success-checkpoint", expected: JSON.stringify(artifact.successCheckpoint), observed: `url=${page.url()}`, screenshotPath },
    };
  }

  return { status: "success", outputs, escalated };
}
