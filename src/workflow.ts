export type WorkflowEvent =
  | {
      type: "phase_started";
      name: string;
    }
  | {
      type: "phase_completed";
      name: string;
      summary: string;
    }
  | {
      type: "verification_result";
      name: string;
      passed: boolean;
      summary: string;
    };

export type WorkflowRecorder = {
  events: WorkflowEvent[];
  recordPhaseStarted(name: string): void;
  recordPhaseCompleted(name: string, summary: string): void;
  recordVerificationResult(name: string, passed: boolean, summary: string): void;
};

export function createWorkflowRecorder(): WorkflowRecorder {
  const events: WorkflowEvent[] = [];

  return {
    events,
    recordPhaseStarted(name) {
      events.push({ type: "phase_started", name });
    },
    recordPhaseCompleted(name, summary) {
      events.push({ type: "phase_completed", name, summary });
    },
    recordVerificationResult(name, passed, summary) {
      events.push({ type: "verification_result", name, passed, summary });
    },
  };
}

export async function runWorkflowPhase<T>(
  workflow: WorkflowRecorder,
  name: string,
  action: () => Promise<T>,
  summarize: (result: T) => string,
): Promise<T> {
  workflow.recordPhaseStarted(name);
  const result = await action();
  workflow.recordPhaseCompleted(name, summarize(result));
  return result;
}
