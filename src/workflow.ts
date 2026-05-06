import { SpanStatusCode } from "@opentelemetry/api";
import {
  emitTelemetryLog,
  getTracer,
  recordWorkflowPhaseMetric,
} from "./telemetry.js";

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
      recordWorkflowPhaseMetric(name, "started");
      emitTelemetryLog("workflow_phase_started", "Workflow phase started.", {
        "workflow.phase": name,
      });
      events.push({ type: "phase_started", name });
    },
    recordPhaseCompleted(name, summary) {
      recordWorkflowPhaseMetric(name, "completed");
      emitTelemetryLog("workflow_phase_completed", "Workflow phase completed.", {
        "workflow.phase": name,
        "workflow.summary_length": summary.length,
      });
      events.push({ type: "phase_completed", name, summary });
    },
    recordVerificationResult(name, passed, summary) {
      recordWorkflowPhaseMetric(name, "verification", passed ? "passed" : "failed");
      emitTelemetryLog("workflow_verification_result", "Workflow verification result.", {
        "workflow.phase": name,
        status: passed ? "passed" : "failed",
        "workflow.summary_length": summary.length,
      });
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
  return getTracer().startActiveSpan("workflow.phase", async (span) => {
    span.setAttribute("workflow.phase", name);
    workflow.recordPhaseStarted(name);

    try {
      const result = await action();
      const summary = summarize(result);
      span.setAttribute("workflow.summary_length", summary.length);
      span.setStatus({ code: SpanStatusCode.OK });
      workflow.recordPhaseCompleted(name, summary);
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Workflow phase failed." });
      span.recordException(new Error("Workflow phase failed."));
      throw error;
    } finally {
      span.end();
    }
  });
}
