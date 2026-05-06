import { runAgent } from "./agent.js";
import { type SecurityOptions } from "./securityPolicy.js";
import { createWorkflowRecorder } from "./workflow.js";

export function buildSpecPrompt(task: string): string {
  return `Create a short implementation specification for this task.

Task:
${task}

Do not modify files.
Do not call tools.
Do not include hidden reasoning.

Use this exact format:
1. Requirement summary
2. Assumptions
3. Edge cases
4. Files likely affected
5. Test plan
6. Confirmation question`;
}

export async function runSpecFirst(
  task: string,
  security?: SecurityOptions,
): Promise<string> {
  const workflow = createWorkflowRecorder();

  workflow.recordPhaseStarted("spec-generation");
  workflow.recordPhaseCompleted("spec-generation", "Specification generation requested without tools.");
  const spec = await runAgent(buildSpecPrompt(task), {
    mode: "spec-first",
    includeTools: false,
    security,
    promptForRecord: task,
    workflowEvents: workflow.events,
  });

  return spec;
}
