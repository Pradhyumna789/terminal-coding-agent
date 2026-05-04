import { type ChatMessage, type ToolCall, sendMessagesToLlm } from "./llmClient.js";
import {
  type AgentRunMode,
  type BlackBoxRecorder,
  createBlackBoxRecorder,
} from "./blackBoxRecorder.js";
import { bashTool } from "./tools/bashTool.js";
import { readTool } from "./tools/readTool.js";
import { searchFilesTool } from "./tools/searchFilesTool.js";
import { typeCheckTool } from "./tools/typeCheckTool.js";
import { writeTool } from "./tools/writeTool.js";
import {
  logAgentDebug,
  logToolError,
  logToolStart,
  logToolSuccess,
  redactSecretValues,
} from "./traceLogger.js";

const MAX_AGENT_STEPS = 50;

type RunAgentOptions = {
  maxSteps?: number | null;
  mode?: AgentRunMode;
};

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

function parseSearchFilesToolArguments(rawArguments: string | undefined): string {
  if (!rawArguments) {
    throw new Error("SearchFiles tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("SearchFiles tool arguments must be valid JSON.");
  }

  const args = parsed as { query?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.query !== "string" ||
    args.query.trim() === ""
  ) {
    throw new Error("SearchFiles tool requires query as a non-empty string.");
  }

  return args.query;
}

function summarizeToolResult(toolName: string, result: string): string {
  if (toolName === "Read") {
    return `Read completed. ${result.length} characters returned.`;
  }

  if (toolName === "SearchFiles") {
    if (result.startsWith("No files matched")) {
      return result;
    }

    const matchCount = result.split("\n").filter(Boolean).length;
    return `Found ${matchCount} matching path(s).`;
  }

  const firstLine = result.split("\n").find((line) => line.trim() !== "");
  return firstLine ?? `${toolName} completed.`;
}

async function saveRecorderSafely(recorder: BlackBoxRecorder): Promise<void> {
  try {
    await recorder.save();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[recorder] failed to save run: ${message}`);
  }
}

async function executeToolCall(
  toolCall: ToolCall,
  recorder: BlackBoxRecorder,
): Promise<string> {
  if (!toolCall.id) {
    throw new Error("Tool call is missing an id.");
  }

  const toolName = toolCall.function?.name;
  const startedAt = Date.now();

  if (toolName === "Read") {
    const filePath = parseReadToolArguments(toolCall.function?.arguments);
    logToolStart("Read", { file_path: filePath });
    recorder.recordToolCall("Read", { file_path: filePath });
    recorder.recordFileRead(filePath);

    try {
      const result = await readTool(filePath);
      logToolSuccess("Read", Date.now() - startedAt);
      recorder.recordToolResult("Read", summarizeToolResult("Read", result));
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
    recorder.recordToolCall("Write", {
      file_path: args.filePath,
      content_length: args.content.length,
    });
    recorder.recordFileWritten(args.filePath);

    try {
      const result = await writeTool(args.filePath, args.content);
      logToolSuccess("Write", Date.now() - startedAt);
      recorder.recordToolResult("Write", summarizeToolResult("Write", result));
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
    recorder.recordToolCall("Bash", { command: redactSecretValues(command) });
    recorder.recordBashCommand(command);

    try {
      const result = await bashTool(command);
      logToolSuccess("Bash", Date.now() - startedAt);
      recorder.recordToolResult("Bash", summarizeToolResult("Bash", result));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Bash", Date.now() - startedAt, message);
      throw error;
    }
  }

  if (toolName === "SearchFiles") {
    const query = parseSearchFilesToolArguments(toolCall.function?.arguments);
    logToolStart("SearchFiles", { query });
    recorder.recordToolCall("SearchFiles", { query });

    try {
      const result = await searchFilesTool(query);
      logToolSuccess("SearchFiles", Date.now() - startedAt);
      recorder.recordToolResult("SearchFiles", summarizeToolResult("SearchFiles", result));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("SearchFiles", Date.now() - startedAt, message);
      throw error;
    }
  }

  if (toolName === "TypeCheck") {
    logToolStart("TypeCheck", { command: "npm run typecheck" });
    recorder.recordToolCall("TypeCheck", { command: "npm run typecheck" });

    try {
      const result = await typeCheckTool();
      logToolSuccess("TypeCheck", Date.now() - startedAt);
      const summary = summarizeToolResult("TypeCheck", result);
      recorder.recordToolResult("TypeCheck", summary);
      recorder.recordTypeCheckResult(summary);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("TypeCheck", Date.now() - startedAt, message);
      throw error;
    }
  }

  throw new Error(`Unsupported tool requested: ${toolName ?? "unknown"}`);
}

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;
  const recorder = createBlackBoxRecorder({
    prompt,
    mode: options.mode,
  });
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: prompt,
    },
  ];

  try {
    for (let step = 0; maxSteps === null || step < maxSteps; step += 1) {
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

        recorder.recordFinalAnswer(finalContent);
        await saveRecorderSafely(recorder);
        return finalContent;
      }

      for (const toolCall of toolCalls) {
        if (!toolCall.id) {
          throw new Error("Tool call is missing an id.");
        }

        const toolResult = await executeToolCall(toolCall, recorder);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }

    throw new Error(`Agent stopped after reaching the maximum of ${maxSteps} steps.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    recorder.recordError(message);
    await saveRecorderSafely(recorder);
    throw error;
  }
}
