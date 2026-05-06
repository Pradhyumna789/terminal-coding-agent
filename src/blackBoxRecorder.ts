import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecretValues } from "./traceLogger.js";
import { emitTelemetryLog } from "./telemetry.js";
import { type AgentIdentity } from "./multiAgent/types.js";

export type AgentRunMode =
  | "normal"
  | "interactive"
  | "spec-first"
  | "tdd"
  | "docs"
  | "acp"
  | "acp-real"
  | "multi-agent";

type RecorderArguments = Record<string, string | number>;

type AgentRunEvent =
  | {
      type: "phase_started";
      timestamp: string;
      name: string;
    }
  | {
      type: "phase_completed";
      timestamp: string;
      name: string;
      summary: string;
    }
  | {
      type: "verification_result";
      timestamp: string;
      name: string;
      passed: boolean;
      summary: string;
    }
  | {
      type: "tool_call";
      timestamp: string;
      toolName: string;
      args: RecorderArguments;
    }
  | {
      type: "tool_result";
      timestamp: string;
      toolName: string;
      summary: string;
    }
  | {
      type: "tool_error";
      timestamp: string;
      toolName: string;
      message: string;
    }
  | {
      type: "final_answer";
      timestamp: string;
      summary: string;
    }
  | {
      type: "error";
      timestamp: string;
      message: string;
    };

type AgentRunRecord = {
  id: string;
  timestamp: string;
  mode: AgentRunMode;
  orchestrationId?: string;
  agent?: {
    id: string;
    name: string;
    role: string;
    mode: "multi-agent";
  };
  traceId: string | null;
  prompt: string;
  conversationMessageCountBeforeRun?: number;
  conversationMessageCountAfterRun?: number;
  events: AgentRunEvent[];
  filesRead: string[];
  filesWritten: string[];
  bashCommands: string[];
  typeCheckResults: string[];
  observability: {
    traceId: string | null;
    rootSpanId: string | null;
    durationMs: number | null;
    toolCallCount: number;
    toolErrorCount: number;
    llmRequestCount: number;
    verificationStatus: "passed" | "failed" | "not_recorded";
    status: "running" | "success" | "error";
  };
  finalAnswer?: string;
  error?: string;
};

export type BlackBoxRecorder = {
  recordToolCall(toolName: string, args: RecorderArguments): void;
  recordToolResult(toolName: string, summary: string): void;
  recordToolError(toolName: string, errorMessage: string): void;
  recordLlmRequest(): void;
  recordFileRead(filePath: string): void;
  recordFileWritten(filePath: string): void;
  recordBashCommand(command: string): void;
  recordTypeCheckResult(summary: string): void;
  recordPhaseStarted(name: string): void;
  recordPhaseCompleted(name: string, summary: string): void;
  recordVerificationResult(name: string, passed: boolean, summary: string): void;
  recordFinalAnswer(answer: string): void;
  recordError(errorMessage: string): void;
  setConversationMessageCountAfterRun(count: number): void;
  save(): Promise<void>;
};

function now(): string {
  return new Date().toISOString();
}

function safeTimestamp(): string {
  return now().replace(/[:.]/g, "-");
}

function sanitizeText(value: string): string {
  return redactSecretValues(value);
}

function truncate(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function sanitizeArgs(args: RecorderArguments): RecorderArguments {
  const sanitized: RecorderArguments = {};

  for (const [key, value] of Object.entries(args)) {
    sanitized[key] = typeof value === "string" ? truncate(sanitizeText(value)) : value;
  }

  return sanitized;
}

export function createBlackBoxRecorder(input: {
  prompt: string;
  mode?: AgentRunMode;
  traceId?: string | null;
  rootSpanId?: string | null;
  conversationMessageCountBeforeRun?: number;
  identity?: AgentIdentity;
}): BlackBoxRecorder {
  const startedAt = Date.now();
  const traceId = input.traceId ?? null;
  const record: AgentRunRecord = {
    id: randomUUID(),
    timestamp: now(),
    mode: input.mode ?? "normal",
    orchestrationId: input.identity?.orchestrationId,
    agent: input.identity
      ? {
          id: input.identity.agentId,
          name: input.identity.agentName,
          role: input.identity.agentRole,
          mode: input.identity.agentMode,
        }
      : undefined,
    traceId,
    prompt: truncate(sanitizeText(input.prompt)),
    conversationMessageCountBeforeRun: input.conversationMessageCountBeforeRun,
    events: [],
    filesRead: [],
    filesWritten: [],
    bashCommands: [],
    typeCheckResults: [],
    observability: {
      traceId,
      rootSpanId: input.rootSpanId ?? null,
      durationMs: null,
      toolCallCount: 0,
      toolErrorCount: 0,
      llmRequestCount: 0,
      verificationStatus: "not_recorded",
      status: "running",
    },
  };

  return {
    recordPhaseStarted(name) {
      record.events.push({
        type: "phase_started",
        timestamp: now(),
        name: truncate(sanitizeText(name)),
      });
    },
    recordPhaseCompleted(name, summary) {
      record.events.push({
        type: "phase_completed",
        timestamp: now(),
        name: truncate(sanitizeText(name)),
        summary: truncate(sanitizeText(summary)),
      });
    },
    recordVerificationResult(name, passed, summary) {
      if (!passed) {
        record.observability.verificationStatus = "failed";
      } else if (record.observability.verificationStatus === "not_recorded") {
        record.observability.verificationStatus = "passed";
      }

      record.events.push({
        type: "verification_result",
        timestamp: now(),
        name: truncate(sanitizeText(name)),
        passed,
        summary: truncate(sanitizeText(summary)),
      });
    },
    recordToolCall(toolName, args) {
      record.observability.toolCallCount += 1;
      record.events.push({
        type: "tool_call",
        timestamp: now(),
        toolName,
        args: sanitizeArgs(args),
      });
    },
    recordToolResult(toolName, summary) {
      record.events.push({
        type: "tool_result",
        timestamp: now(),
        toolName,
        summary: truncate(sanitizeText(summary)),
      });
    },
    recordToolError(toolName, errorMessage) {
      const message = truncate(sanitizeText(errorMessage));
      record.observability.toolErrorCount += 1;
      record.events.push({
        type: "tool_error",
        timestamp: now(),
        toolName,
        message,
      });
    },
    recordLlmRequest() {
      record.observability.llmRequestCount += 1;
    },
    recordFileRead(filePath) {
      record.filesRead.push(truncate(sanitizeText(filePath)));
    },
    recordFileWritten(filePath) {
      record.filesWritten.push(truncate(sanitizeText(filePath)));
    },
    recordBashCommand(command) {
      record.bashCommands.push(truncate(sanitizeText(command)));
    },
    recordTypeCheckResult(summary) {
      record.typeCheckResults.push(truncate(sanitizeText(summary)));
    },
    recordFinalAnswer(answer) {
      const summary = truncate(sanitizeText(answer));
      record.finalAnswer = summary;
      record.observability.status = "success";
      record.events.push({
        type: "final_answer",
        timestamp: now(),
        summary,
      });
    },
    recordError(errorMessage) {
      const message = truncate(sanitizeText(errorMessage));
      record.error = message;
      record.observability.status = "error";
      record.events.push({
        type: "error",
        timestamp: now(),
        message,
      });
    },
    setConversationMessageCountAfterRun(count) {
      record.conversationMessageCountAfterRun = count;
    },
    async save() {
      const runsDirectory = join(process.cwd(), "runs");
      const fileName = record.agent
        ? `${safeTimestamp()}-${record.mode}-${record.agent.id}-${record.id}.json`
        : `${safeTimestamp()}-${record.mode}-${record.id}.json`;

      record.observability.durationMs = Date.now() - startedAt;
      await mkdir(runsDirectory, { recursive: true });
      await writeFile(join(runsDirectory, fileName), JSON.stringify(record, null, 2), "utf-8");
      emitTelemetryLog("recorder_save", "Black-box recorder saved run record.", {
        "recorder.mode": record.mode,
        "recorder.status": record.observability.status,
        "recorder.tool_call_count": record.observability.toolCallCount,
        "recorder.tool_error_count": record.observability.toolErrorCount,
        "recorder.llm_request_count": record.observability.llmRequestCount,
      }, undefined, input.identity);
    },
  };
}
