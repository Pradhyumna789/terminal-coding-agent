import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  formatTypeScriptDiagnostics,
  parseTypeScriptDiagnostics,
} from "../diagnostics/typescriptDiagnostics.js";

const execAsync = promisify(exec);
const TYPECHECK_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BUFFER = 1024 * 1024;

type CommandError = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: unknown;
  stderr?: unknown;
};

function toOutputText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }

  return "";
}

function formatTypeCheckResult(exitCode: number | string, stdout = "", stderr = ""): string {
  const diagnostics = parseTypeScriptDiagnostics(`${stdout}\n${stderr}`);

  return `Exit code: ${exitCode}
Structured diagnostics:
${formatTypeScriptDiagnostics(diagnostics)}

Raw output:
STDOUT:
${stdout}

STDERR:
${stderr}`;
}

export async function typeCheckTool(): Promise<string> {
  try {
    const result = await execAsync("npm run typecheck", {
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
      windowsHide: true,
    });

    return formatTypeCheckResult(0, toOutputText(result.stdout), toOutputText(result.stderr));
  } catch (error) {
    const commandError = error as CommandError;
    const exitCode = commandError.killed
      ? "timeout"
      : commandError.code ?? commandError.signal ?? "error";
    const stderr = commandError.killed
      ? `TypeCheck timed out after ${TYPECHECK_TIMEOUT_MS}ms.\n${toOutputText(commandError.stderr)}`
      : toOutputText(commandError.stderr);

    return formatTypeCheckResult(exitCode, toOutputText(commandError.stdout), stderr);
  }
}
