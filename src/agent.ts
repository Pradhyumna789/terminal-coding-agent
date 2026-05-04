import {
  context as otelContext,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { type ChatMessage, type ToolCall, sendMessagesToLlm } from "./llmClient.js";
import {
  type AgentRunMode,
  type BlackBoxRecorder,
  createBlackBoxRecorder,
} from "./blackBoxRecorder.js";
import { bashTool } from "./tools/bashTool.js";
import { documentSymbolsTool } from "./tools/documentSymbolsTool.js";
import { readTool } from "./tools/readTool.js";
import { searchFilesTool } from "./tools/searchFilesTool.js";
import { typeCheckTool } from "./tools/typeCheckTool.js";
import { writeTool } from "./tools/writeTool.js";
import { getTracer } from "./telemetry.js";
import {
  logAgentDebug,
  logToolError,
  logToolStart,
  logToolSuccess,
  redactSecretValues,
} from "./traceLogger.js";

const MAX_AGENT_STEPS = 50;

type AgentEventArguments = Record<string, string | number>;

export type AgentEvent =
  | {
      type: "agent_started";
      prompt: string;
    }
  | {
      type: "tool_started";
      toolName: string;
      args: AgentEventArguments;
    }
  | {
      type: "tool_completed";
      toolName: string;
      durationMs: number;
    }
  | {
      type: "tool_error";
      toolName: string;
      durationMs: number;
      error: string;
    }
  | {
      type: "agent_completed";
      finalAnswer: string;
    }
  | {
      type: "agent_error";
      error: string;
    };

type AgentEventHandler = (event: AgentEvent) => void;

type RunAgentOptions = {
  maxSteps?: number | null;
  mode?: AgentRunMode;
  onEvent?: AgentEventHandler;
};

function sanitizeEventText(value: string): string {
  return redactSecretValues(value);
}

function emitAgentEvent(onEvent: AgentEventHandler | undefined, event: AgentEvent): void {
  onEvent?.(event);
}

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

function parseDocumentSymbolsToolArguments(rawArguments: string | undefined): string {
  if (!rawArguments) {
    throw new Error("DocumentSymbols tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("DocumentSymbols tool arguments must be valid JSON.");
  }

  const args = parsed as { file_path?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.file_path !== "string" ||
    args.file_path.trim() === ""
  ) {
    throw new Error("DocumentSymbols tool requires file_path as a non-empty string.");
  }

  return args.file_path;
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

function getToolSpanName(toolName: string | undefined): string {
  if (toolName === "DocumentSymbols") {
    return "tool.LSP";
  }

  if (toolName) {
    return `tool.${toolName}`;
  }

  return "tool.unknown";
}

function startToolSpan(toolName: string | undefined, toolCallId: string): Span {
  const safeToolName = toolName ?? "unknown";
  const span = getTracer().startSpan(getToolSpanName(toolName));

  span.setAttribute("tool.name", safeToolName);
  span.setAttribute("tool.call_id", toolCallId);

  return span;
}

function setToolFilePath(span: Span, filePath: string): void {
  span.setAttribute("tool.file_path", redactSecretValues(filePath));
}

function finishToolSpan(span: Span, durationMs: number, result: string): void {
  span.setAttribute("tool.duration_ms", durationMs);
  span.setAttribute("tool.result_length", result.length);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function failToolSpan(span: Span, durationMs: number, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";

  span.setAttribute("tool.duration_ms", durationMs);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: redactSecretValues(message),
  });
  span.end();
}

function getValidTraceId(span: Span): string | null {
  const traceId = span.spanContext().traceId;

  if (!traceId || /^0+$/.test(traceId)) {
    return null;
  }

  return traceId;
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
  onEvent?: AgentEventHandler,
): Promise<string> {
  if (!toolCall.id) {
    throw new Error("Tool call is missing an id.");
  }

  const toolName = toolCall.function?.name;
  const startedAt = Date.now();
  const span = startToolSpan(toolName, toolCall.id);
  let spanEnded = false;

  try {
    if (toolName === "Read") {
    const filePath = parseReadToolArguments(toolCall.function?.arguments);
    setToolFilePath(span, filePath);
    logToolStart("Read", { file_path: filePath });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "Read",
      args: { file_path: sanitizeEventText(filePath) },
    });
    recorder.recordToolCall("Read", { file_path: filePath });
    recorder.recordFileRead(filePath);

    try {
      const result = await readTool(filePath);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("Read", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "Read",
        durationMs,
      });
      recorder.recordToolResult("Read", summarizeToolResult("Read", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Read", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "Read",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "Write") {
    const args = parseWriteToolArguments(toolCall.function?.arguments);
    setToolFilePath(span, args.filePath);
    span.setAttribute("tool.content_length", args.content.length);
    logToolStart("Write", {
      file_path: args.filePath,
      content_length: args.content.length,
    });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "Write",
      args: {
        file_path: sanitizeEventText(args.filePath),
        content_length: args.content.length,
      },
    });
    recorder.recordToolCall("Write", {
      file_path: args.filePath,
      content_length: args.content.length,
    });
    recorder.recordFileWritten(args.filePath);

    try {
      const result = await writeTool(args.filePath, args.content);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("Write", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "Write",
        durationMs,
      });
      recorder.recordToolResult("Write", summarizeToolResult("Write", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Write", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "Write",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "Bash") {
    const command = parseBashToolArguments(toolCall.function?.arguments);
    span.setAttribute("tool.command_redacted", redactSecretValues(command));
    logToolStart("Bash", { command: redactSecretValues(command) });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "Bash",
      args: { command: sanitizeEventText(command) },
    });
    recorder.recordToolCall("Bash", { command: redactSecretValues(command) });
    recorder.recordBashCommand(command);

    try {
      const result = await bashTool(command);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("Bash", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "Bash",
        durationMs,
      });
      recorder.recordToolResult("Bash", summarizeToolResult("Bash", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Bash", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "Bash",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "SearchFiles") {
    const query = parseSearchFilesToolArguments(toolCall.function?.arguments);
    span.setAttribute("tool.query", redactSecretValues(query));
    logToolStart("SearchFiles", { query });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "SearchFiles",
      args: { query: sanitizeEventText(query) },
    });
    recorder.recordToolCall("SearchFiles", { query });

    try {
      const result = await searchFilesTool(query);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("SearchFiles", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "SearchFiles",
        durationMs,
      });
      recorder.recordToolResult("SearchFiles", summarizeToolResult("SearchFiles", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("SearchFiles", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "SearchFiles",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "TypeCheck") {
    span.setAttribute("tool.command_redacted", "npm run typecheck");
    logToolStart("TypeCheck", { command: "npm run typecheck" });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "TypeCheck",
      args: { command: "npm run typecheck" },
    });
    recorder.recordToolCall("TypeCheck", { command: "npm run typecheck" });

    try {
      const result = await typeCheckTool();
      const durationMs = Date.now() - startedAt;
      logToolSuccess("TypeCheck", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "TypeCheck",
        durationMs,
      });
      const summary = summarizeToolResult("TypeCheck", result);
      recorder.recordToolResult("TypeCheck", summary);
      recorder.recordTypeCheckResult(summary);
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("TypeCheck", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "TypeCheck",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "DocumentSymbols") {
    const filePath = parseDocumentSymbolsToolArguments(toolCall.function?.arguments);
    setToolFilePath(span, filePath);
    logToolStart("DocumentSymbols", { file_path: filePath });
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "DocumentSymbols",
      args: { file_path: sanitizeEventText(filePath) },
    });
    recorder.recordToolCall("DocumentSymbols", { file_path: filePath });
    recorder.recordFileRead(filePath);

    try {
      const result = await documentSymbolsTool(filePath);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("DocumentSymbols", durationMs);
      finishToolSpan(span, durationMs, result);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "DocumentSymbols",
        durationMs,
      });
      recorder.recordToolResult(
        "DocumentSymbols",
        summarizeToolResult("DocumentSymbols", result),
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("DocumentSymbols", durationMs, message);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "DocumentSymbols",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

    throw new Error(`Unsupported tool requested: ${toolName ?? "unknown"}`);
  } catch (error) {
    if (!spanEnded) {
      failToolSpan(span, Date.now() - startedAt, error);
    }

    throw error;
  }
}

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;
  const agentSpan = getTracer().startSpan("agent.run");
  const activeContext = trace.setSpan(otelContext.active(), agentSpan);

  agentSpan.setAttribute("agent.mode", options.mode ?? "normal");
  agentSpan.setAttribute("agent.prompt_length", prompt.length);
  agentSpan.setAttribute("agent.max_steps", maxSteps === null ? "unlimited" : maxSteps);

  return otelContext.with(activeContext, async () => {
    const recorder = createBlackBoxRecorder({
      prompt,
      mode: options.mode,
      traceId: getValidTraceId(agentSpan),
    });
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: prompt,
      },
    ];

    try {
      emitAgentEvent(options.onEvent, {
        type: "agent_started",
        prompt: sanitizeEventText(prompt),
      });

      for (let step = 0; maxSteps === null || step < maxSteps; step += 1) {
        agentSpan.setAttribute("agent.current_step", step + 1);

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
          agentSpan.setAttribute("agent.final_answer_length", finalContent.length);
          agentSpan.setStatus({ code: SpanStatusCode.OK });
          emitAgentEvent(options.onEvent, {
            type: "agent_completed",
            finalAnswer: sanitizeEventText(finalContent),
          });
          await saveRecorderSafely(recorder);
          return finalContent;
        }

        for (const toolCall of toolCalls) {
          if (!toolCall.id) {
            throw new Error("Tool call is missing an id.");
          }

          const toolResult = await executeToolCall(toolCall, recorder, options.onEvent);

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
      agentSpan.recordException(error instanceof Error ? error : new Error(message));
      agentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactSecretValues(message),
      });
      emitAgentEvent(options.onEvent, {
        type: "agent_error",
        error: sanitizeEventText(message),
      });
      await saveRecorderSafely(recorder);
      throw error;
    } finally {
      agentSpan.end();
    }
  });
}
