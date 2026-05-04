import {
  formatDoneCriteriaResult,
  runDoneCriteria,
} from "./doneCriteria.js";
import { runAgent } from "./agent.js";

function buildTddPrompt(task: string): string {
  return `You are in TDD mode.

Task:
${task}

Follow this order:
1. Inspect relevant project files first.
2. Check whether a test framework or test script exists.
3. If tests exist, create or update tests before implementation.
4. Run the relevant failing test or TypeCheck before implementation.
5. Implement the smallest code change needed.
6. Run verification again.
7. Final answer must summarize:
   - test file changes
   - implementation file changes
   - verification command and result

If no test framework exists:
- Do not invent a large setup silently.
- Explain that no test framework exists.
- Offer a minimal test setup plan.
- You may use TypeCheck as the fallback verification only if it fits the task.`;
}

export async function runTddMode(task: string): Promise<string> {
  const agentSummary = await runAgent(buildTddPrompt(task), {
    maxSteps: null,
    mode: "tdd",
  });
  const doneCriteria = await runDoneCriteria(agentSummary);
  const doneCriteriaReport = formatDoneCriteriaResult(doneCriteria);

  if (!doneCriteria.passed) {
    return `${agentSummary}

${doneCriteriaReport}

Status: NOT DONE. One or more required verification checks failed.`;
  }

  return `${agentSummary}

${doneCriteriaReport}`;
}
