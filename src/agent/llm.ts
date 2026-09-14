import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Thin, swappable wrapper around the LLM used for discovery. Only this file
 * (plus prompts.ts) is provider-specific; the agent loop talks to the
 * ToolCall/Message shapes below, not to the OpenAI SDK directly.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmTurn {
  toolCalls: ToolCall[];
  rawContent: string | null;
}

export class LlmClient {
  private client: OpenAI;
  private model: string;

  constructor(model = process.env.OPENAI_MODEL ?? "gpt-4o") {
    this.client = new OpenAI();
    this.model = model;
  }

  async step(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<LlmTurn> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      tool_choice: "required",
      temperature: 0,
    });
    const choice = completion.choices[0];
    const calls = choice.message.tool_calls ?? [];
    return {
      rawContent: choice.message.content,
      toolCalls: calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: JSON.parse(c.function.arguments || "{}"),
      })),
    };
  }
}
