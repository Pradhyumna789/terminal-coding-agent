import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecretValues } from "./traceLogger.js";

export type AgentRunMode = "normal" | "tdd" | "docs";

type RecorderArguments = Record<string, string | number>;

type AgentRunEvent =
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
  recordFinalAnswer(answer: string): void;
  recordError(errorMessage: string): void;
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
}): BlackBoxRecorder {
  const record: AgentRunRecord = {
    id: randomUUID(),
    timestamp: now(),
    mode: input.mode ?? "normal",
    traceId: input.traceId ?? null,
    prompt: truncate(sanitizeText(input.prompt)),
    events: [],
    filesRead: [],
    filesWritten: [],
    bashCommands: [],
    typeCheckResults: [],
  };

  return {
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
      record.filesRead.push(filePath);
    },
    recordFileWritten(filePath) {
      record.filesWritten.push(filePath);
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
    async save() {
      const runsDirectory = join(process.cwd(), "runs");
      const fileName = `${safeTimestamp()}-${record.mode}-${record.id}.json`;

      await mkdir(runsDirectory, { recursive: true });
      await writeFile(join(runsDirectory, fileName), JSON.stringify(record, null, 2), "utf-8");
    },
  };
}
