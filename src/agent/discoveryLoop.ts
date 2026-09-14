import type { Page } from "playwright";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LlmClient } from "./llm.js";
import { SYSTEM_PROMPT, TOOLS } from "./prompts.js";
import { perceive, renderPerceivedState, type PerceivedState } from "../perception/accessibilityTree.js";
import { actClick, actType, actSelect, actNavigate, actExtract, GuardrailViolation } from "./actions.js";
import type { RunLogger } from "../evidence/logger.js";

export interface DiscoveryTraceStep {
  action: "navigate" | "click" | "type" | "select" | "extract";
  resolvedLocator?: { role: string; name: string };
  structuralLocatorCss?: string;
  value?: string;
  outputName?: string;
  urlAfter: string;
}

export interface DiscoveryResult {
  success: boolean;
  outputs: Record<string, unknown>;
  trace: DiscoveryTraceStep[];
  stopReason: string;
  escalated: boolean;
}

export interface DiscoveryOptions {
  goal: string;
  startUrl: string;
  maxSteps?: number;
}

export async function runDiscovery(page: Page, opts: DiscoveryOptions, logger: RunLogger): Promise<DiscoveryResult> {
  const llm = new LlmClient();
  const maxSteps = opts.maxSteps ?? 20;
  const trace: DiscoveryTraceStep[] = [];

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Goal: ${opts.goal}\nStart URL: ${opts.startUrl}\nBegin by navigating to the start URL.` },
  ];

  let lastState: PerceivedState | null = null;

  for (let step = 0; step < maxSteps; step++) {
    lastState = await perceive(page);
    await logger.screenshot(page, `step-${step}-before`);
    const stateText = renderPerceivedState(lastState);
    messages.push({ role: "user", content: `Current state (step ${step}):\n${stateText}` });

    const turn = await llm.step(messages, TOOLS);
    const call = turn.toolCalls[0];
    if (!call) {
      logger.log("agent.no_tool_call", { rawContent: turn.rawContent });
      return { success: false, outputs: {}, trace, stopReason: "Model returned no tool call.", escalated: false };
    }
    messages.push({
      role: "assistant",
      content: turn.rawContent,
      tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
    });
    logger.log("agent.tool_call", { name: call.name, arguments: call.arguments });

    if (call.name === "finish") {
      const success = Boolean(call.arguments.success);
      const outputs = (call.arguments.outputs as Record<string, unknown>) ?? {};
      logger.log("agent.finish", { success, outputs, reason: call.arguments.reason });
      return { success, outputs, trace, stopReason: String(call.arguments.reason ?? ""), escalated: false };
    }
    if (call.name === "request_help") {
      logger.log("agent.request_help", { reason: call.arguments.reason });
      return { success: false, outputs: {}, trace, stopReason: String(call.arguments.reason ?? "model requested help"), escalated: true };
    }

    const ref = call.arguments.ref as string | undefined;
    const node = ref ? lastState.nodes.find((n) => n.ref === ref) : undefined;
    let toolResultText: string;
    try {
      if (call.name === "navigate") {
        const url = String(call.arguments.url);
        await actNavigate(page, url);
        trace.push({ action: "navigate", value: url, urlAfter: page.url() });
        toolResultText = `Navigated to ${url}.`;
      } else if (!node) {
        toolResultText = `Error: ref "${ref}" not found in current state. Re-perceive and try again.`;
      } else if (call.name === "click") {
        const outcome = await actClick(page, node, { enforceRiskBlock: true });
        if (!outcome.ok) {
          toolResultText = `Blocked: ${outcome.blockedReason}`;
        } else {
          trace.push({ action: "click", resolvedLocator: outcome.resolvedLocator, urlAfter: page.url() });
          toolResultText = `Clicked "${node.name}".`;
        }
      } else if (call.name === "type") {
        const text = String(call.arguments.text);
        const outcome = await actType(page, node, text, { enforceRiskBlock: true });
        if (!outcome.ok) {
          toolResultText = `Blocked: ${outcome.blockedReason}`;
        } else {
          trace.push({ action: "type", resolvedLocator: outcome.resolvedLocator, value: text, urlAfter: page.url() });
          toolResultText = `Typed into "${node.name}".`;
        }
      } else if (call.name === "select") {
        const option = String(call.arguments.option);
        const outcome = await actSelect(page, node, option, { enforceRiskBlock: true });
        if (!outcome.ok) {
          toolResultText = `Blocked: ${outcome.blockedReason}`;
        } else {
          trace.push({ action: "select", resolvedLocator: outcome.resolvedLocator, value: option, urlAfter: page.url() });
          toolResultText = `Selected "${option}" in "${node.name}".`;
        }
      } else if (call.name === "extract") {
        const outputName = String(call.arguments.outputName);
        const outcome = await actExtract(page, node, { enforceRiskBlock: true });
        if (!outcome.ok) {
          toolResultText = `Blocked: ${outcome.blockedReason}`;
        } else {
          trace.push({
            action: "extract",
            resolvedLocator: outcome.resolvedLocator,
            structuralLocatorCss: outcome.structuralLocatorCss,
            outputName,
            urlAfter: page.url(),
          });
          toolResultText = `Extracted "${node.name}" -> ${outputName} = "${outcome.extractedValue}"`;
        }
      } else {
        toolResultText = `Unknown tool "${call.name}".`;
      }
    } catch (err) {
      if (err instanceof GuardrailViolation) {
        toolResultText = `Guardrail violation: ${err.message}`;
        logger.log("guardrail.violation", { message: err.message, tool: call.name });
      } else {
        toolResultText = `Error executing ${call.name}: ${(err as Error).message}`;
        logger.log("agent.action_error", { error: (err as Error).message, tool: call.name });
      }
    }

    logger.log("agent.tool_result", { name: call.name, result: toolResultText });
    messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText });
  }

  return { success: false, outputs: {}, trace, stopReason: "Max steps reached without finishing.", escalated: false };
}
