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
    .replace(/bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>");
}

export function logToolStart(toolName: string, args: TraceArguments): void {
  console.error(`[tool] ${timestamp()} ${toolName} started ${JSON.stringify(args)}`);
}

export function logToolSuccess(toolName: string, durationMs: number): void {
  console.error(`[tool] ${timestamp()} ${toolName} success ${durationMs}ms`);
}

export function logToolError(toolName: string, durationMs: number, errorMessage: string): void {
  console.error(`[tool] ${timestamp()} ${toolName} error ${durationMs}ms ${errorMessage}`);
}
