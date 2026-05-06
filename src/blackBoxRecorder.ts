import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecretValues } from "./traceLogger.js";

export type AgentRunMode = "normal" | "interactive" | "spec-first" | "tdd" | "docs";

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
  traceId: string | null;
  prompt: string;
  conversationMessageCountBeforeRun?: number;
  conversationMessageCountAfterRun?: number;
  events: AgentRunEvent[];
  filesRead: string[];
  filesWritten: string[];
  bashCommands: string[];
  typeCheckResults: string[];
  finalAnswer?: string;
  error?: string;
};

export type BlackBoxRecorder = {
  recordToolCall(toolName: string, args: RecorderArguments): void;
  recordToolResult(toolName: string, summary: string): void;
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
  conversationMessageCountBeforeRun?: number;
}): BlackBoxRecorder {
  const record: AgentRunRecord = {
    id: randomUUID(),
    timestamp: now(),
    mode: input.mode ?? "normal",
    traceId: input.traceId ?? null,
    prompt: truncate(sanitizeText(input.prompt)),
    conversationMessageCountBeforeRun: input.conversationMessageCountBeforeRun,
    events: [],
    filesRead: [],
    filesWritten: [],
    bashCommands: [],
    typeCheckResults: [],
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
      record.events.push({
        type: "verification_result",
        timestamp: now(),
        name: truncate(sanitizeText(name)),
        passed,
        summary: truncate(sanitizeText(summary)),
      });
    },
    recordToolCall(toolName, args) {
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
      record.events.push({
        type: "final_answer",
        timestamp: now(),
        summary,
      });
    },
    recordError(errorMessage) {
      const message = truncate(sanitizeText(errorMessage));
      record.error = message;
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
      const fileName = `${safeTimestamp()}-${record.mode}-${record.id}.json`;

      await mkdir(runsDirectory, { recursive: true });
      await writeFile(join(runsDirectory, fileName), JSON.stringify(record, null, 2), "utf-8");
    },
  };
}
