import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { SpanStatusCode } from "@opentelemetry/api";
import { handleAcpRealMessage } from "./acpRealMode.js";
import { type AgentEvent, runAgent } from "./agent.js";
import { type SecurityOptions } from "./securityPolicy.js";
import {
  getTracer,
  recordAcpRequestMetric,
} from "./telemetry.js";
import { redactSecretValues } from "./traceLogger.js";

type AcpRunRequest = {
  type: "run";
  id: string;
  prompt: string;
};

type AcpCapabilities = {
  tools: string[];
  modes: string[];
  supportsStreamingEvents: boolean;
};

type AcpEvent =
  | {
      type: "pong";
      id: string;
    }
  | {
      type: "capabilities_result";
      id: string;
      capabilities: AcpCapabilities;
    }
  | {
      type: "started";
      id: string;
    }
  | {
      type: "completed";
      id: string;
      finalAnswer: string;
    }
  | {
      type: "agent_event";
      id: string;
      event: AgentEvent;
    }
  | {
      type: "error";
      id?: string;
      error: string;
    };

const ACP_CAPABILITIES: AcpCapabilities = {
  tools: [
    "Read",
    "Write",
    "Bash",
    "SearchFiles",
    "TypeCheck",
    "DocumentSymbols",
    "GoToDefinition",
    "FindReferences",
  ],
  modes: ["one-shot", "interactive", "spec-first", "tdd", "docs", "acp"],
  supportsStreamingEvents: true,
};

function writeEvent(event: AcpEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

function sanitizeText(value: string): string {
  return redactSecretValues(value);
}

function isJsonRpcMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

function getOptionalId(value: unknown): string | undefined {
  const message = value as { id?: unknown };

  return typeof message.id === "string" && message.id.trim() !== ""
    ? message.id
    : undefined;
}

function getRequiredId(value: unknown): string {
  const id = getOptionalId(value);

  if (!id) {
    throw new Error("ACP message requires a non-empty id.");
  }

  return id;
}

function getRequiredType(value: unknown): string {
  const message = value as { type?: unknown };

  if (typeof value !== "object" || value === null || typeof message.type !== "string") {
    throw new Error("ACP message requires a non-empty type.");
  }

  const type = message.type.trim();

  if (!type) {
    throw new Error("ACP message requires a non-empty type.");
  }

  return type;
}

function parseRunRequest(value: unknown, id: string): AcpRunRequest {
  const message = value as {
    prompt?: unknown;
  };

  if (typeof value !== "object" || value === null || typeof message.prompt !== "string") {
    throw new Error("ACP run request requires type, id, and prompt.");
  }

  const prompt = message.prompt.trim();

  if (!prompt) {
    throw new Error("ACP run request requires type, id, and prompt.");
  }

  return {
    type: "run",
    id,
    prompt: message.prompt,
  };
}

async function handleRunRequest(
  request: AcpRunRequest,
  security: SecurityOptions,
): Promise<void> {
  writeEvent({
    type: "started",
    id: request.id,
  });

  try {
    const finalAnswer = await runAgent(request.prompt, {
      security,
      mode: "acp",
      onEvent(event) {
        writeEvent({
          type: "agent_event",
          id: request.id,
          event,
        });
      },
    });
    writeEvent({
      type: "completed",
      id: request.id,
      finalAnswer: sanitizeText(finalAnswer),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeEvent({
      type: "error",
      id: request.id,
      error: sanitizeText(message),
    });
  }
}

async function handleMessage(parsed: unknown, security: SecurityOptions): Promise<void> {
  let id: string;
  let messageType: string;

  try {
    id = getRequiredId(parsed);
    messageType = getRequiredType(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid ACP request.";
    writeEvent({
      type: "error",
      id: getOptionalId(parsed),
      error: message,
    });
    return;
  }

  return getTracer().startActiveSpan("acp.request", async (span) => {
    const startedAt = Date.now();
    span.setAttribute("acp.type", messageType);
    span.setAttribute("acp.id_length", id.length);
    recordAcpRequestMetric(messageType, "started");

    try {
      if (messageType === "ping") {
        writeEvent({
          type: "pong",
          id,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        recordAcpRequestMetric(messageType, "success", Date.now() - startedAt);
        return;
      }

      if (messageType === "capabilities") {
        writeEvent({
          type: "capabilities_result",
          id,
          capabilities: ACP_CAPABILITIES,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        recordAcpRequestMetric(messageType, "success", Date.now() - startedAt);
        return;
      }

      if (messageType === "run") {
        try {
          await handleRunRequest(parseRunRequest(parsed, id), security);
          span.setStatus({ code: SpanStatusCode.OK });
          recordAcpRequestMetric(messageType, "success", Date.now() - startedAt);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid ACP request.";
          writeEvent({
            type: "error",
            id,
            error: sanitizeText(message),
          });
          span.setStatus({ code: SpanStatusCode.ERROR, message: "ACP run failed." });
          span.recordException(new Error("ACP run failed."));
          recordAcpRequestMetric(messageType, "error", Date.now() - startedAt);
        }
        return;
      }

      writeEvent({
        type: "error",
        id,
        error: `Unsupported ACP message type: ${messageType}`,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Unsupported ACP message type." });
      recordAcpRequestMetric(messageType, "error", Date.now() - startedAt);
    } finally {
      span.end();
    }
  });
}

async function handleLine(line: string, security: SecurityOptions): Promise<void> {
  const trimmedLine = line.trim();

  if (!trimmedLine) {
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    writeEvent({
      type: "error",
      error: "Invalid JSON input.",
    });
    return;
  }

  if (isJsonRpcMessage(parsed)) {
    await handleAcpRealMessage(parsed, security);
    return;
  }

  await handleMessage(parsed, security);
}

export async function runAcpMode(security: SecurityOptions = {}): Promise<void> {
  const rl = createInterface({
    input: stdin,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      await handleLine(line, security);
    }
  } finally {
    rl.close();
  }
}
