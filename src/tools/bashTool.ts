import { spawn } from "node:child_process";
import { validateBashCommand } from "../securityPolicy.js";

const BASH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BUFFER = 1024 * 1024;

type CommandResult = {
  exitCode: number | string;
  stdout: string;
  stderr: string;
};

function formatCommandResult(exitCode: number | string, stdout = "", stderr = ""): string {
  return `Exit code: ${exitCode}
STDOUT:
${stdout}

STDERR:
${stderr}`;
}

function getPowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function buildLocalSpawnArgs(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: getPowerShellExecutable(),
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }

  return {
    command: "sh",
    args: ["-lc", command],
  };
}

function buildDockerSpawnArgs(command: string): { command: string; args: string[] } {
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "-v",
      `${process.cwd()}:/workspace`,
      "-w",
      "/workspace",
      "node:20-alpine",
      "sh",
      "-lc",
      command,
    ],
  };
}

async function runCommand(command: string): Promise<CommandResult> {
  const useDockerSandbox = process.env.AGENT_BASH_SANDBOX === "docker";
  const spawnTarget = useDockerSandbox
    ? buildDockerSpawnArgs(command)
    : buildLocalSpawnArgs(command);

  return new Promise((resolve) => {
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill();
        finished = true;
        resolve({
          exitCode: "timeout",
          stdout,
          stderr: `Command timed out after ${BASH_TIMEOUT_MS}ms.\n${stderr}`,
        });
      }
    }, BASH_TIMEOUT_MS);

    function appendOutput(kind: "stdout" | "stderr", chunk: Buffer): void {
      if (finished) {
        return;
      }

      const text = chunk.toString("utf-8");

      if (kind === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }

      if (stdout.length + stderr.length > MAX_OUTPUT_BUFFER) {
        child.kill();
        finished = true;
        clearTimeout(timeout);
        resolve({
          exitCode: "max-buffer",
          stdout,
          stderr: `Command output exceeded ${MAX_OUTPUT_BUFFER} bytes.\n${stderr}`,
        });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));

    child.on("error", (error) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        resolve({
          exitCode: "error",
          stdout,
          stderr: error.message,
        });
      }
    });

    child.on("close", (code, signal) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        resolve({
          exitCode: code ?? signal ?? "error",
          stdout,
          stderr,
        });
      }
    });
  });
}

export async function bashTool(command: string): Promise<string> {
  try {
    validateBashCommand(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown security policy error";
    return formatCommandResult("blocked", "", message);
  }

  const result = await runCommand(command);
  return formatCommandResult(result.exitCode, result.stdout, result.stderr);
}
