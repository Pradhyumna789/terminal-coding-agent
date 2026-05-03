import { type ChatMessage, type ToolCall, sendMessagesToLlm } from "./llmClient.js";
import { bashTool } from "./tools/bashTool.js";
import { readTool } from "./tools/readTool.js";
import { writeTool } from "./tools/writeTool.js";
import {
  logAgentDebug,
  logToolError,
  logToolStart,
  logToolSuccess,
  redactSecretValues,
} from "./traceLogger.js";

const MAX_AGENT_STEPS = 5;

function getMessageRoleSummary(messages: ChatMessage[]): string {
  return messages.map((message) => message.role).join(" -> ");
}

function parseReadToolArguments(rawArguments: string | undefined): string {
  if (!rawArguments) {
    throw new Error("Read tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("Read tool arguments must be valid JSON.");
  }

  const args = parsed as { file_path?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.file_path !== "string" ||
    args.file_path.trim() === ""
  ) {
    throw new Error("Read tool requires file_path as a non-empty string.");
  }

  return args.file_path;
}

function parseWriteToolArguments(rawArguments: string | undefined): {
  filePath: string;
  content: string;
} {
  if (!rawArguments) {
    throw new Error("Write tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("Write tool arguments must be valid JSON.");
  }

  const args = parsed as { file_path?: unknown; content?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.file_path !== "string" ||
    args.file_path.trim() === ""
  ) {
    throw new Error("Write tool requires file_path as a non-empty string.");
  }

  if (typeof args.content !== "string") {
    throw new Error("Write tool requires content as a string.");
  }

  return {
    filePath: args.file_path,
    content: args.content,
  };
}

function parseBashToolArguments(rawArguments: string | undefined): string {
  if (!rawArguments) {
    throw new Error("Bash tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("Bash tool arguments must be valid JSON.");
  }

  const args = parsed as { command?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.command !== "string" ||
    args.command.trim() === ""
  ) {
    throw new Error("Bash tool requires command as a non-empty string.");
  }

  return args.command;
}

async function executeToolCall(toolCall: ToolCall): Promise<string> {
  if (!toolCall.id) {
    throw new Error("Tool call is missing an id.");
  }

  const toolName = toolCall.function?.name;
  const startedAt = Date.now();

  if (toolName === "Read") {
    const filePath = parseReadToolArguments(toolCall.function?.arguments);
    logToolStart("Read", { file_path: filePath });

    try {
      const result = await readTool(filePath);
      logToolSuccess("Read", Date.now() - startedAt);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Read", Date.now() - startedAt, message);
      throw error;
    }
  }

  if (toolName === "Write") {
    const args = parseWriteToolArguments(toolCall.function?.arguments);
    logToolStart("Write", {
      file_path: args.filePath,
      content_length: args.content.length,
    });

    try {
      const result = await writeTool(args.filePath, args.content);
      logToolSuccess("Write", Date.now() - startedAt);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Write", Date.now() - startedAt, message);
      throw error;
    }
  }

  if (toolName === "Bash") {
    const command = parseBashToolArguments(toolCall.function?.arguments);
    logToolStart("Bash", { command: redactSecretValues(command) });

    try {
      const result = await bashTool(command);
      logToolSuccess("Bash", Date.now() - startedAt);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Bash", Date.now() - startedAt, message);
      throw error;
    }
  }

  throw new Error(`Unsupported tool requested: ${toolName ?? "unknown"}`);
}

export async function runAgent(prompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: prompt,
    },
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    const assistantMessage = await sendMessagesToLlm(messages);
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    const finalContent = assistantMessage.content?.trim();

    if (toolCalls.length === 0) {
      if (!finalContent) {
        const agentStep = step + 1;

        logAgentDebug("empty assistant response", {
          step: agentStep,
          message_count: messages.length,
          roles: getMessageRoleSummary(messages),
        });

        throw new Error(
          `The model returned an empty response at agent step ${agentStep}: no assistant content and no tool calls. Try a different model or a shorter prompt.`,
        );
      }

      return assistantMessage.content;
    }

    for (const toolCall of toolCalls) {
      if (!toolCall.id) {
        throw new Error("Tool call is missing an id.");
      }

      const toolResult = await executeToolCall(toolCall);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  throw new Error(`Agent stopped after reaching the maximum of ${MAX_AGENT_STEPS} steps.`);
}
