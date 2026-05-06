import { readFile } from "node:fs/promises";
import {
  formatDoneCriteriaResult,
  runDoneCriteria,
} from "./doneCriteria.js";
import { runAgent } from "./agent.js";
import { type SecurityOptions } from "./securityPolicy.js";
import { resolveProjectPath } from "./tools/pathSafety.js";
import { createWorkflowRecorder, runWorkflowPhase } from "./workflow.js";

type ProjectTestSetup = {
  hasTestScript: boolean;
  testScript: string | null;
};

export const TDD_AGENT_MAX_STEPS = null;

async function inspectProjectTestSetup(): Promise<ProjectTestSetup> {
  const packageJsonPath = await resolveProjectPath("package.json");
  const rawPackageJson = await readFile(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(rawPackageJson) as {
    scripts?: Record<string, unknown>;
  };
  const testScript =
    typeof packageJson.scripts?.test === "string"
      ? packageJson.scripts.test.trim()
      : null;

  return {
    hasTestScript: Boolean(testScript && !testScript.includes("no test specified")),
    testScript,
  };
}

function summarizeTestSetup(setup: ProjectTestSetup): string {
  if (setup.hasTestScript) {
    return `Detected npm test script: ${setup.testScript}`;
  }

  return "No npm test script detected; TypeCheck remains the required fallback.";
}

export function buildTddPrompt(task: string, setup?: ProjectTestSetup): string {
  const testSetupSummary = setup ? summarizeTestSetup(setup) : "Test setup has not been inspected yet.";

  return `You are in TDD mode.

Task:
${task}

Detected project test setup:
${testSetupSummary}

Follow this order:
1. Inspect relevant project files first.
2. Create or update tests before implementation when a test target exists.
3. Run the relevant failing test or TypeCheck before implementation.
4. Implement the smallest code change needed.
5. Run verification again.
6. Final answer must summarize:
   - test file changes
   - implementation file changes
   - verification command and result

If no test framework exists:
- Do not invent a large setup silently.
- Explain that no test framework exists.
- Offer a minimal test setup plan.
- You may use TypeCheck as the fallback verification only if it fits the task.`;
}

export async function runTddMode(task: string, security?: SecurityOptions): Promise<string> {
  const workflow = createWorkflowRecorder();
  const setup = await runWorkflowPhase(
    workflow,
    "test-setup-inspection",
    inspectProjectTestSetup,
    summarizeTestSetup,
  );

  workflow.recordPhaseStarted("tdd-agent-run");
  workflow.recordPhaseCompleted("tdd-agent-run", "TDD agent run requested with unlimited steps.");
  const agentSummary = await runAgent(buildTddPrompt(task, setup), {
    maxSteps: TDD_AGENT_MAX_STEPS,
    mode: "tdd",
    security,
    promptForRecord: task,
    workflowEvents: workflow.events,
  });

  const doneCriteria = await runWorkflowPhase(
    workflow,
    "done-criteria",
    () => runDoneCriteria(agentSummary),
    (result) => formatDoneCriteriaResult(result),
  );
  const doneCriteriaReport = formatDoneCriteriaResult(doneCriteria);
  workflow.recordVerificationResult("done-criteria", doneCriteria.passed, doneCriteriaReport);

  if (!doneCriteria.passed) {
    return `${agentSummary}

${doneCriteriaReport}

Status: NOT DONE. One or more required verification checks failed.`;
  }

  return `${agentSummary}

${doneCriteriaReport}`;
}
