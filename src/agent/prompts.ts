import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const SYSTEM_PROMPT = `You are a computer-use agent operating a legacy back-office banking web application on behalf of a bank teller.
You perceive the page as a pruned accessibility tree (role + accessible name for each interactable element, tagged with a short ref like [n3]).
You act ONLY by calling one of the provided tools, one at a time. Always act on the CURRENT state given to you — do not assume prior actions succeeded beyond what the latest state shows.
Prefer the most direct path to the goal. If an element you need isn't present, look for navigation links/back buttons rather than guessing a URL.
If you reach a state you don't understand, or an action is blocked by policy, or you are stuck (e.g. the same state repeats), call request_help with a clear reason instead of guessing further.
When the goal is achieved, call finish with success=true and the requested outputs. If the goal cannot be completed for a legitimate business reason (e.g. no such record), call finish with success=true and outputs describing that business outcome — this is not a failure, it's a correct answer.
Only call finish with success=false for a genuine dead end.`;

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an interactable element by its ref from the current perceived state.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "The [ref] of the target element, e.g. n3" } },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into a textbox element by its ref, replacing any existing value.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
        },
        required: ["ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select",
      description: "Choose an option (by visible label) in a combobox/select element by its ref.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          option: { type: "string" },
        },
        required: ["ref", "option"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the browser directly to a URL. Only use this for the initial entry point.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract",
      description: "Read the text/value of an element by its ref and record it under a named output.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          outputName: { type: "string", description: "Name to store this value under, e.g. savingsBalance" },
        },
        required: ["ref", "outputName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_help",
      description: "Stop and escalate to a human operator because you cannot safely proceed.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the run: the goal was achieved (possibly as a legitimate business outcome) or is a dead end.",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          outputs: { type: "object", description: "Map of output name -> value, matching any prior extract() calls." },
          reason: { type: "string" },
        },
        required: ["success", "reason"],
      },
    },
  },
];
