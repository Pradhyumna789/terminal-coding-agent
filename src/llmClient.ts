import { tools } from "./tools/schemas.js";

const LLM_REQUEST_TIMEOUT_MS = 30_000;

export type ToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ChatMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

type LlmResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseAssistantMessage(data: LlmResponse): AssistantMessage {
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error("LLM response did not contain an assistant message.");
  }

  return {
    role: "assistant",
    content: message.content ?? null,
    tool_calls: message.tool_calls,
  };
}

export async function sendMessagesToLlm(messages: ChatMessage[]): Promise<AssistantMessage> {
  const apiUrl = getRequiredEnv("LLM_API_URL");
  const apiKey = getRequiredEnv("LLM_API_KEY");
  const model = getRequiredEnv("LLM_MODEL");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API request failed with status ${response.status}`);
    }

    const data = (await response.json()) as LlmResponse;
    return parseAssistantMessage(data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `LLM API request timed out after ${LLM_REQUEST_TIMEOUT_MS / 1000} seconds. Try again, use a shorter prompt, or switch to a faster model.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
