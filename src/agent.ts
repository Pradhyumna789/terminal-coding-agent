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
import { findReferencesTool } from "./tools/findReferencesTool.js";
import { goToDefinitionTool } from "./tools/goToDefinitionTool.js";
import { readTool } from "./tools/readTool.js";
import { searchFilesTool, type SearchFilesOptions } from "./tools/searchFilesTool.js";
import { typeCheckTool } from "./tools/typeCheckTool.js";
import { writeTool } from "./tools/writeTool.js";
import { type AgentIdentity } from "./multiAgent/types.js";
import {
  emitTelemetryLog,
  identityAttributes,
  recordAgentRunCompleted,
  recordAgentRunStarted,
  recordToolMetric,
  getTracer,
} from "./telemetry.js";
import {
  formatUntrustedFileContent,
  isSensitiveFilePath,
  requireToolApproval,
  SECURITY_SYSTEM_MESSAGE,
  type SecurityOptions,
  validateBashCommand,
} from "./securityPolicy.js";
import {
  logAgentDebug,
  logToolError,
  logToolStart,
  logToolSuccess,
  redactSecretValues,
} from "./traceLogger.js";
import { type WorkflowEvent } from "./workflow.js";

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
  includeTools?: boolean;
  onEvent?: AgentEventHandler;
  promptForRecord?: string;
  conversationMessageCountBeforeRun?: number;
  security?: SecurityOptions;
  workflowEvents?: WorkflowEvent[];
  identity?: AgentIdentity;
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

function ensureSecuritySystemMessage(messages: ChatMessage[]): void {
  if (
    messages.some(
      (message) => message.role === "system" && message.content === SECURITY_SYSTEM_MESSAGE,
    )
  ) {
    return;
  }

  messages.unshift({
    role: "system",
    content: SECURITY_SYSTEM_MESSAGE,
  });
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

function parseSearchFilesToolArguments(rawArguments: string | undefined): {
  query: string;
  options: SearchFilesOptions;
} {
  if (!rawArguments) {
    throw new Error("SearchFiles tool call is missing arguments.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("SearchFiles tool arguments must be valid JSON.");
  }

  const args = parsed as { query?: unknown; search_text?: unknown; max_results?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.query !== "string" ||
    args.query.trim() === ""
  ) {
    throw new Error("SearchFiles tool requires query as a non-empty string.");
  }

  if (args.search_text !== undefined && typeof args.search_text !== "boolean") {
    throw new Error("SearchFiles search_text must be a boolean when provided.");
  }

  if (args.max_results !== undefined && typeof args.max_results !== "number") {
    throw new Error("SearchFiles max_results must be a number when provided.");
  }

  return {
    query: args.query,
    options: {
      searchText: args.search_text,
      maxResults: args.max_results,
    },
  };
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

function parseLspLocationToolArguments(
  toolName: "GoToDefinition" | "FindReferences",
  rawArguments: string | undefined,
): {
  filePath: string;
  line: number;
  column: number;
} {
  if (!rawArguments) {
    throw new Error(`${toolName} tool call is missing arguments.`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error(`${toolName} tool arguments must be valid JSON.`);
  }

  const args = parsed as { file_path?: unknown; line?: unknown; column?: unknown };

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof args.file_path !== "string" ||
    args.file_path.trim() === ""
  ) {
    throw new Error(`${toolName} requires file_path as a non-empty string.`);
  }

  if (
    typeof args.line !== "number" ||
    !Number.isInteger(args.line) ||
    args.line < 1 ||
    typeof args.column !== "number" ||
    !Number.isInteger(args.column) ||
    args.column < 1
  ) {
    throw new Error(`${toolName} requires line and column as positive integers.`);
  }

  return {
    filePath: args.file_path,
    line: args.line,
    column: args.column,
  };
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
  if (
    toolName === "DocumentSymbols" ||
    toolName === "GoToDefinition" ||
    toolName === "FindReferences"
  ) {
    return "tool.LSP";
  }

  if (toolName) {
    return `tool.${toolName}`;
  }

  return "tool.unknown";
}

function startToolSpan(
  toolName: string | undefined,
  toolCallId: string,
  identity?: AgentIdentity,
): Span {
  const safeToolName = toolName ?? "unknown";
  const span = getTracer().startSpan(getToolSpanName(toolName));

  span.setAttribute("tool.name", safeToolName);
  span.setAttribute("tool.call_id", toolCallId);
  span.setAttributes(identityAttributes(identity));
  recordToolMetric(safeToolName, "started", undefined, identity);

  return span;
}

function setToolFilePath(span: Span, filePath: string): void {
  span.setAttribute("tool.file_path", redactSecretValues(filePath));
}

function finishToolSpan(
  span: Span,
  toolName: string,
  durationMs: number,
  result: string,
  identity?: AgentIdentity,
): void {
  span.setAttribute("tool.duration_ms", durationMs);
  span.setAttribute("tool.result_length", result.length);
  span.setStatus({ code: SpanStatusCode.OK });
  recordToolMetric(toolName, "success", durationMs, identity);
  span.end();
}

function failToolSpan(
  span: Span,
  toolName: string,
  durationMs: number,
  error: unknown,
  identity?: AgentIdentity,
): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  const safeMessage = redactSecretValues(message);

  span.setAttribute("tool.duration_ms", durationMs);
  span.recordException(error instanceof Error ? new Error(safeMessage) : new Error(safeMessage));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: safeMessage,
  });
  recordToolMetric(toolName, "error", durationMs, identity);
  span.end();
}

function getValidTraceId(span: Span): string | null {
  const traceId = span.spanContext().traceId;

  if (!traceId || /^0+$/.test(traceId)) {
    return null;
  }

  return traceId;
}

function getValidSpanId(span: Span): string | null {
  const spanId = span.spanContext().spanId;

  if (!spanId || /^0+$/.test(spanId)) {
    return null;
  }

  return spanId;
}

async function saveRecorderSafely(
  recorder: BlackBoxRecorder,
  identity?: AgentIdentity,
): Promise<void> {
  try {
    await recorder.save();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const safeMessage = redactSecretValues(message);
    console.error(`[recorder] failed to save run: ${safeMessage}`);
    emitTelemetryLog("recorder_save_error", "Black-box recorder failed to save run record.", {
      "error.message": safeMessage,
    }, undefined, identity);
  }
}

function recordWorkflowEvents(recorder: BlackBoxRecorder, events: WorkflowEvent[]): void {
  for (const event of events) {
    if (event.type === "phase_started") {
      recorder.recordPhaseStarted(event.name);
      continue;
    }

    if (event.type === "phase_completed") {
      recorder.recordPhaseCompleted(event.name, event.summary);
      continue;
    }

    recorder.recordVerificationResult(event.name, event.passed, event.summary);
  }
}

async function executeToolCall(
  toolCall: ToolCall,
  recorder: BlackBoxRecorder,
  onEvent?: AgentEventHandler,
  security?: SecurityOptions,
  identity?: AgentIdentity,
): Promise<string> {
  if (!toolCall.id) {
    throw new Error("Tool call is missing an id.");
  }

  const toolName = toolCall.function?.name;
  const startedAt = Date.now();
  const span = startToolSpan(toolName, toolCall.id, identity);
  let spanEnded = false;

  try {
    if (toolName === "Read") {
    const filePath = parseReadToolArguments(toolCall.function?.arguments);
    if (isSensitiveFilePath(filePath)) {
      await requireToolApproval(security, {
        toolName: "Read",
        reason: "Read requested a sensitive file path.",
        details: { file_path: sanitizeEventText(filePath) },
      });
    }
    setToolFilePath(span, filePath);
    logToolStart("Read", { file_path: filePath }, identity);
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "Read",
      args: { file_path: sanitizeEventText(filePath) },
    });
    recorder.recordToolCall("Read", { file_path: filePath });
    recorder.recordFileRead(filePath);

    try {
      const rawResult = await readTool(filePath);
      const result = formatUntrustedFileContent(filePath, rawResult);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("Read", durationMs, identity);
      finishToolSpan(span, "Read", durationMs, result, identity);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "Read",
        durationMs,
      });
      recorder.recordToolResult("Read", summarizeToolResult("Read", rawResult));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("Read", durationMs, message, identity);
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
    await requireToolApproval(security, {
      toolName: "Write",
      reason: "Write can create or overwrite project files.",
      details: {
        file_path: sanitizeEventText(args.filePath),
        content_length: args.content.length,
      },
    });
    setToolFilePath(span, args.filePath);
    span.setAttribute("tool.content_length", args.content.length);
    logToolStart("Write", {
      file_path: args.filePath,
      content_length: args.content.length,
    }, identity);
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
      logToolSuccess("Write", durationMs, identity);
      finishToolSpan(span, "Write", durationMs, result, identity);
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
      logToolError("Write", durationMs, message, identity);
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
    validateBashCommand(command);
    await requireToolApproval(security, {
      toolName: "Bash",
      reason: "Bash executes a local command.",
      details: { command: sanitizeEventText(command) },
    });
    span.setAttribute("tool.command_redacted", redactSecretValues(command));
    logToolStart("Bash", { command: redactSecretValues(command) }, identity);
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
      logToolSuccess("Bash", durationMs, identity);
      finishToolSpan(span, "Bash", durationMs, result, identity);
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
      logToolError("Bash", durationMs, message, identity);
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
    const { query, options } = parseSearchFilesToolArguments(toolCall.function?.arguments);
    span.setAttribute("tool.query", redactSecretValues(query));
    span.setAttribute("tool.search_text", options.searchText ?? false);
    span.setAttribute("tool.max_results", options.maxResults ?? 25);
    logToolStart("SearchFiles", { query }, identity);
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "SearchFiles",
      args: { query: sanitizeEventText(query) },
    });
    recorder.recordToolCall("SearchFiles", {
      query,
      search_text: options.searchText ? 1 : 0,
      max_results: options.maxResults ?? 25,
    });

    try {
      const result = await searchFilesTool(query, options);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("SearchFiles", durationMs, identity);
      finishToolSpan(span, "SearchFiles", durationMs, result, identity);
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
      logToolError("SearchFiles", durationMs, message, identity);
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
    logToolStart("TypeCheck", { command: "npm run typecheck" }, identity);
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "TypeCheck",
      args: { command: "npm run typecheck" },
    });
    recorder.recordToolCall("TypeCheck", { command: "npm run typecheck" });

    try {
      const result = await typeCheckTool();
      const durationMs = Date.now() - startedAt;
      logToolSuccess("TypeCheck", durationMs, identity);
      finishToolSpan(span, "TypeCheck", durationMs, result, identity);
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
      logToolError("TypeCheck", durationMs, message, identity);
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
    logToolStart("DocumentSymbols", { file_path: filePath }, identity);
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
      logToolSuccess("DocumentSymbols", durationMs, identity);
      finishToolSpan(span, "DocumentSymbols", durationMs, result, identity);
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
      logToolError("DocumentSymbols", durationMs, message, identity);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "DocumentSymbols",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "GoToDefinition") {
    const args = parseLspLocationToolArguments("GoToDefinition", toolCall.function?.arguments);
    setToolFilePath(span, args.filePath);
    logToolStart("GoToDefinition", {
      file_path: args.filePath,
      line: args.line,
      column: args.column,
    }, identity);
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "GoToDefinition",
      args: {
        file_path: sanitizeEventText(args.filePath),
        line: args.line,
        column: args.column,
      },
    });
    recorder.recordToolCall("GoToDefinition", {
      file_path: args.filePath,
      line: args.line,
      column: args.column,
    });
    recorder.recordFileRead(args.filePath);

    try {
      const result = await goToDefinitionTool(args.filePath, args.line, args.column);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("GoToDefinition", durationMs, identity);
      finishToolSpan(span, "GoToDefinition", durationMs, result, identity);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "GoToDefinition",
        durationMs,
      });
      recorder.recordToolResult("GoToDefinition", summarizeToolResult("GoToDefinition", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("GoToDefinition", durationMs, message, identity);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "GoToDefinition",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

  if (toolName === "FindReferences") {
    const args = parseLspLocationToolArguments("FindReferences", toolCall.function?.arguments);
    setToolFilePath(span, args.filePath);
    logToolStart("FindReferences", {
      file_path: args.filePath,
      line: args.line,
      column: args.column,
    }, identity);
    emitAgentEvent(onEvent, {
      type: "tool_started",
      toolName: "FindReferences",
      args: {
        file_path: sanitizeEventText(args.filePath),
        line: args.line,
        column: args.column,
      },
    });
    recorder.recordToolCall("FindReferences", {
      file_path: args.filePath,
      line: args.line,
      column: args.column,
    });
    recorder.recordFileRead(args.filePath);

    try {
      const result = await findReferencesTool(args.filePath, args.line, args.column);
      const durationMs = Date.now() - startedAt;
      logToolSuccess("FindReferences", durationMs, identity);
      finishToolSpan(span, "FindReferences", durationMs, result, identity);
      spanEnded = true;
      emitAgentEvent(onEvent, {
        type: "tool_completed",
        toolName: "FindReferences",
        durationMs,
      });
      recorder.recordToolResult("FindReferences", summarizeToolResult("FindReferences", result));
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : "Unknown error";
      logToolError("FindReferences", durationMs, message, identity);
      emitAgentEvent(onEvent, {
        type: "tool_error",
        toolName: "FindReferences",
        durationMs,
        error: sanitizeEventText(message),
      });
      throw error;
    }
  }

    throw new Error(`Unsupported tool requested: ${toolName ?? "unknown"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    recorder.recordToolError(toolName ?? "unknown", message);
    if (!spanEnded) {
      failToolSpan(span, toolName ?? "unknown", Date.now() - startedAt, error, identity);
    }

    throw error;
  }
}

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: prompt,
    },
  ];

  return runAgentWithMessages(messages, {
    ...options,
    promptForRecord: options.promptForRecord ?? prompt,
  });
}

function getLastUserPrompt(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "user") {
      return message.content;
    }
  }

  return "";
}

export async function runAgentWithMessages(
  messages: ChatMessage[],
  options: RunAgentOptions = {},
): Promise<string> {
  const promptForRecord = options.promptForRecord ?? getLastUserPrompt(messages);
  ensureSecuritySystemMessage(messages);
  const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;
  const mode = options.mode ?? "normal";
  const identity = options.identity;
  const startedAt = Date.now();
  const agentSpan = getTracer().startSpan("agent.run");
  const activeContext = trace.setSpan(otelContext.active(), agentSpan);

  recordAgentRunStarted(mode, identity);
  agentSpan.setAttribute("agent.mode", mode);
  agentSpan.setAttribute("agent.prompt_length", promptForRecord.length);
  agentSpan.setAttribute("agent.max_steps", maxSteps === null ? "unlimited" : maxSteps);
  agentSpan.setAttribute("agent.message_count_start", messages.length);
  agentSpan.setAttributes(identityAttributes(identity));

  return otelContext.with(activeContext, async () => {
    const recorder = createBlackBoxRecorder({
      prompt: promptForRecord,
      mode,
      traceId: getValidTraceId(agentSpan),
      rootSpanId: getValidSpanId(agentSpan),
      conversationMessageCountBeforeRun: options.conversationMessageCountBeforeRun,
      identity,
    });
    recordWorkflowEvents(recorder, options.workflowEvents ?? []);

    try {
      emitAgentEvent(options.onEvent, {
        type: "agent_started",
        prompt: sanitizeEventText(promptForRecord),
      });

      for (let step = 0; maxSteps === null || step < maxSteps; step += 1) {
        agentSpan.setAttribute("agent.current_step", step + 1);

        recorder.recordLlmRequest();
        const assistantMessage = await sendMessagesToLlm(messages, {
          includeTools: options.includeTools ?? true,
          identity,
        });
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
            }, identity);

            throw new Error(
              `The model returned an empty response at agent step ${agentStep}: no assistant content and no tool calls. Try a different model or a shorter prompt.`,
            );
          }

          recorder.recordFinalAnswer(finalContent);
          recorder.setConversationMessageCountAfterRun(messages.length);
          agentSpan.setAttribute("agent.final_answer_length", finalContent.length);
          agentSpan.setAttribute("agent.message_count_end", messages.length);
          agentSpan.setStatus({ code: SpanStatusCode.OK });
          getTracer().startActiveSpan("agent.finalize", (finalizeSpan) => {
            finalizeSpan.setAttribute("agent.mode", mode);
            finalizeSpan.setAttribute("agent.status", "success");
            finalizeSpan.setAttribute("agent.final_answer_length", finalContent.length);
            finalizeSpan.setAttributes(identityAttributes(identity));
            finalizeSpan.setStatus({ code: SpanStatusCode.OK });
            finalizeSpan.end();
          });
          recordAgentRunCompleted(mode, "success", Date.now() - startedAt, identity);
          emitAgentEvent(options.onEvent, {
            type: "agent_completed",
            finalAnswer: sanitizeEventText(finalContent),
          });
          await saveRecorderSafely(recorder, identity);
          return finalContent;
        }

        for (const toolCall of toolCalls) {
          if (!toolCall.id) {
            throw new Error("Tool call is missing an id.");
          }

          const toolResult = await executeToolCall(
            toolCall,
            recorder,
            options.onEvent,
            options.security,
            identity,
          );

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
      const safeMessage = redactSecretValues(message);
      recorder.recordError(message);
      recorder.setConversationMessageCountAfterRun(messages.length);
      agentSpan.recordException(new Error(safeMessage));
      agentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: safeMessage,
      });
      getTracer().startActiveSpan("agent.finalize", (finalizeSpan) => {
        finalizeSpan.setAttribute("agent.mode", mode);
        finalizeSpan.setAttribute("agent.status", "error");
        finalizeSpan.setAttributes(identityAttributes(identity));
        finalizeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: safeMessage,
        });
        finalizeSpan.end();
      });
      recordAgentRunCompleted(mode, "error", Date.now() - startedAt, identity);
      emitAgentEvent(options.onEvent, {
        type: "agent_error",
        error: sanitizeEventText(message),
      });
      await saveRecorderSafely(recorder, identity);
      throw error;
    } finally {
      agentSpan.end();
    }
  });
}
