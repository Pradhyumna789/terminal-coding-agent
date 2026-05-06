import { SeverityNumber } from "@opentelemetry/api-logs";
import { emitTelemetryLog } from "./telemetry.js";

type TraceArguments = Record<string, string | number>;

function timestamp(): string {
  return new Date().toISOString();
}

export function redactSecretValues(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|password|secret)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1=<redacted>",
    )
    .replace(
      /\b(OPENROUTER_API_KEY|LLM_API_KEY|AUTHORIZATION)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1=<redacted>",
    )
    .replace(/bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/ghp_[A-Za-z0-9_]+/g, "ghp_<redacted>")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_<redacted>")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "jwt-<redacted>",
    );
}

export function logToolStart(toolName: string, args: TraceArguments): void {
  const safeArgs = redactSecretValues(JSON.stringify(args));
  console.error(
    `[tool] ${timestamp()} ${toolName} started ${safeArgs}`,
  );
  emitTelemetryLog("tool_started", `${toolName} started.`, {
    "tool.name": toolName,
    "tool.args": safeArgs,
  });
}

export function logToolSuccess(toolName: string, durationMs: number): void {
  console.error(`[tool] ${timestamp()} ${toolName} success ${durationMs}ms`);
  emitTelemetryLog("tool_success", `${toolName} succeeded.`, {
    "tool.name": toolName,
    "tool.duration_ms": durationMs,
  });
}

export function logToolError(toolName: string, durationMs: number, errorMessage: string): void {
  const safeMessage = redactSecretValues(errorMessage);
  console.error(
    `[tool] ${timestamp()} ${toolName} error ${durationMs}ms ${safeMessage}`,
  );
  emitTelemetryLog(
    "tool_error",
    `${toolName} failed.`,
    {
      "tool.name": toolName,
      "tool.duration_ms": durationMs,
      "error.message": safeMessage,
    },
    SeverityNumber.ERROR,
  );
}

export function logAgentDebug(message: string, details: Record<string, string | number>): void {
  const safeDetails = redactSecretValues(JSON.stringify(details));
  console.error(`[agent] ${timestamp()} ${message} ${safeDetails}`);
  emitTelemetryLog("agent_debug", redactSecretValues(message), {
    "agent.details": safeDetails,
  });
}
