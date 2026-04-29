import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const BASH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BUFFER = 1024 * 1024;

type CommandError = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: unknown;
  stderr?: unknown;
};

function getBlockedCommandReason(command: string): string | null {
  const normalized = command.toLowerCase().trim();

  if (normalized.includes("rm -rf")) {
    return "rm -rf is destructive";
  }

  if (normalized.includes("del /s")) {
    return "del /s is destructive";
  }

  if (normalized.includes("remove-item") && normalized.includes("-recurse")) {
    return "Remove-Item -Recurse is destructive";
  }

  if (normalized.startsWith("format ")) {
    return "format is destructive";
  }

  if (normalized.includes("shutdown") || normalized.includes("restart-computer")) {
    return "shutdown and restart commands are blocked";
  }

  if (normalized.includes(":(){")) {
    return "fork bomb pattern is blocked";
  }

  if (["vim", "nano", "notepad", "python", "node"].includes(normalized)) {
    return "interactive commands without arguments are blocked";
  }

  return null;
}

function formatCommandResult(exitCode: number | string, stdout = "", stderr = ""): string {
  return `Exit code: ${exitCode}
STDOUT:
${stdout}

STDERR:
${stderr}`;
}

function toOutputText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }

  return "";
}

export async function bashTool(command: string): Promise<string> {
  const blockedReason = getBlockedCommandReason(command);

  if (blockedReason) {
    return formatCommandResult("blocked", "", `Command blocked: ${blockedReason}`);
  }

  try {
    const result = await execAsync(command, {
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
      windowsHide: true,
    });

    return formatCommandResult(0, toOutputText(result.stdout), toOutputText(result.stderr));
  } catch (error) {
    const commandError = error as CommandError;
    const exitCode = commandError.killed
      ? "timeout"
      : commandError.code ?? commandError.signal ?? "error";
    const stderr = commandError.killed
      ? `Command timed out after ${BASH_TIMEOUT_MS}ms.\n${toOutputText(commandError.stderr)}`
      : toOutputText(commandError.stderr);

    return formatCommandResult(exitCode, toOutputText(commandError.stdout), stderr);
  }
}
