import { tools } from "./tools/schemas.js";

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

type SendMessagesOptions = {
  includeTools?: boolean;
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

export async function sendMessagesToLlm(
  messages: ChatMessage[],
  options: SendMessagesOptions = {},
): Promise<AssistantMessage> {
  const apiUrl = getRequiredEnv("LLM_API_URL");
  const apiKey = getRequiredEnv("LLM_API_KEY");
  const model = getRequiredEnv("LLM_MODEL");
  const includeTools = options.includeTools ?? true;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(includeTools ? { tools } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API request failed with status ${response.status}`);
  }

  const data = (await response.json()) as LlmResponse;
  return parseAssistantMessage(data);
}
