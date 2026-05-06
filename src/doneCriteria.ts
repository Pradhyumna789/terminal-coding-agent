import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveProjectPath } from "./tools/pathSafety.js";
import { typeCheckTool } from "./tools/typeCheckTool.js";

const execAsync = promisify(exec);
const TEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BUFFER = 1024 * 1024;

export type DoneCriteriaConfig = {
  requireTypeCheck: boolean;
  requireTestsIfAvailable: boolean;
  requireFinalSummary: boolean;
  testCommand?: string;
};

export type DoneCheckResult = {
  name: string;
  required: boolean;
  passed: boolean;
  skipped: boolean;
  message: string;
};

export type DoneCriteriaResult = {
  passed: boolean;
  checks: DoneCheckResult[];
};

type CommandError = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: unknown;
  stderr?: unknown;
};

export const DEFAULT_DONE_CRITERIA: DoneCriteriaConfig = {
  requireTypeCheck: true,
  requireTestsIfAvailable: true,
  requireFinalSummary: true,
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

async function getPackageScripts(): Promise<Record<string, string>> {
  const packageJsonPath = await resolveProjectPath("package.json");
  const rawPackageJson = await readFile(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(rawPackageJson) as {
    scripts?: Record<string, unknown>;
  };

  const scripts: Record<string, string> = {};

  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (typeof command === "string") {
      scripts[name] = command;
    }
  }

  return scripts;
}

function hasRealTestScript(scripts: Record<string, string>): boolean {
  const testScript = scripts.test?.trim();

  return Boolean(testScript && !testScript.includes("no test specified"));
}

async function runTypeCheckDoneCheck(required: boolean): Promise<DoneCheckResult> {
  const result = await typeCheckTool();
  const passed = result.startsWith("Exit code: 0");

  return {
    name: "TypeCheck",
    required,
    passed,
    skipped: false,
    message: passed ? "npm run typecheck passed." : "npm run typecheck failed.",
  };
}

async function runTestsDoneCheck(
  requiredIfAvailable: boolean,
  testCommand = "npm test",
): Promise<DoneCheckResult> {
  const scripts = await getPackageScripts();

  if (!hasRealTestScript(scripts)) {
    return {
      name: "Tests",
      required: false,
      passed: true,
      skipped: true,
      message: "No real npm test script found in package.json.",
    };
  }

  try {
    await execAsync(testCommand, {
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
      windowsHide: true,
    });

    return {
      name: "Tests",
      required: requiredIfAvailable,
      passed: true,
      skipped: false,
      message: `${testCommand} passed.`,
    };
  } catch (error) {
    const commandError = error as CommandError;
    const exitCode = commandError.killed
      ? "timeout"
      : commandError.code ?? commandError.signal ?? "error";
    const stderr = commandError.killed
      ? `${testCommand} timed out after ${TEST_TIMEOUT_MS}ms.`
      : toOutputText(commandError.stderr).trim();

    return {
      name: "Tests",
      required: requiredIfAvailable,
      passed: false,
      skipped: false,
      message: `${testCommand} failed with exit code ${exitCode}.${stderr ? ` ${stderr}` : ""}`,
    };
  }
}

function runFinalSummaryDoneCheck(required: boolean, finalSummary: string): DoneCheckResult {
  const passed = finalSummary.trim().length > 0;

  return {
    name: "Final summary",
    required,
    passed,
    skipped: false,
    message: passed ? "Final summary was generated." : "Final summary was missing.",
  };
}

export async function runDoneCriteria(
  finalSummary: string,
  config: DoneCriteriaConfig = DEFAULT_DONE_CRITERIA,
): Promise<DoneCriteriaResult> {
  const checks: DoneCheckResult[] = [];

  if (config.requireTypeCheck) {
    checks.push(await runTypeCheckDoneCheck(true));
  }

  if (config.requireTestsIfAvailable) {
    checks.push(await runTestsDoneCheck(true, config.testCommand));
  }

  if (config.requireFinalSummary) {
    checks.push(runFinalSummaryDoneCheck(true, finalSummary));
  }

  const passed = checks.every((check) => check.skipped || check.passed || !check.required);

  return {
    passed,
    checks,
  };
}

export function formatDoneCriteriaResult(result: DoneCriteriaResult): string {
  const status = result.passed ? "PASSED" : "FAILED";
  const checks = result.checks
    .map((check) => {
      const checkStatus = check.skipped ? "SKIPPED" : check.passed ? "PASSED" : "FAILED";
      return `- ${check.name}: ${checkStatus} - ${check.message}`;
    })
    .join("\n");

  return `Done criteria: ${status}
${checks}`;
}
