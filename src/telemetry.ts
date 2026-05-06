import { metrics, trace, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const DEFAULT_SERVICE_NAME = "terminal-coding-agent";
const DEFAULT_SERVICE_VERSION = "0.1.0";
const DEFAULT_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
const DEFAULT_OTLP_METRICS_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_OTLP_LOGS_ENDPOINT = "http://localhost:4318/v1/logs";
const METRIC_EXPORT_INTERVAL_MS = 5_000;

type Status = "started" | "success" | "error";

type TelemetryInstruments = {
  agentRuns: ReturnType<Meter["createCounter"]>;
  agentRunDuration: ReturnType<Meter["createHistogram"]>;
  activeAgentRuns: ReturnType<Meter["createUpDownCounter"]>;
  toolCalls: ReturnType<Meter["createCounter"]>;
  toolFailures: ReturnType<Meter["createCounter"]>;
  toolDuration: ReturnType<Meter["createHistogram"]>;
  llmRequests: ReturnType<Meter["createCounter"]>;
  llmFailures: ReturnType<Meter["createCounter"]>;
  llmRequestDuration: ReturnType<Meter["createHistogram"]>;
  acpRequests: ReturnType<Meter["createCounter"]>;
  activeAcpRequests: ReturnType<Meter["createUpDownCounter"]>;
  activeInteractiveSessions: ReturnType<Meter["createUpDownCounter"]>;
  workflowPhases: ReturnType<Meter["createCounter"]>;
  doneCriteriaChecks: ReturnType<Meter["createCounter"]>;
};

let sdk: NodeSDK | null = null;
let initialized = false;
let instruments: TelemetryInstruments | null = null;

function isTelemetryEnabled(): boolean {
  return process.env.OTEL_ENABLED === "true";
}

function getServiceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
}

function getServiceVersion(): string {
  return process.env.OTEL_SERVICE_VERSION?.trim() || DEFAULT_SERVICE_VERSION;
}

function getDeploymentEnvironment(): string {
  return process.env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || "local";
}

function getOtlpTracesEndpoint(): string {
  return (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || DEFAULT_OTLP_TRACES_ENDPOINT
  );
}

function getOtlpMetricsEndpoint(): string {
  return (
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() || DEFAULT_OTLP_METRICS_ENDPOINT
  );
}

function getOtlpLogsEndpoint(): string {
  return process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || DEFAULT_OTLP_LOGS_ENDPOINT;
}

function getInstruments(): TelemetryInstruments {
  if (instruments) {
    return instruments;
  }

  const meter = getMeter();
  instruments = {
    agentRuns: meter.createCounter("agent_runs_total", {
      description: "Total agent runs started.",
    }),
    agentRunDuration: meter.createHistogram("agent_run_duration_ms", {
      description: "Agent run duration in milliseconds.",
      unit: "ms",
    }),
    activeAgentRuns: meter.createUpDownCounter("agent_runs_active", {
      description: "Active agent runs.",
    }),
    toolCalls: meter.createCounter("agent_tool_calls_total", {
      description: "Total tool calls started.",
    }),
    toolFailures: meter.createCounter("agent_tool_failures_total", {
      description: "Total failed tool calls.",
    }),
    toolDuration: meter.createHistogram("agent_tool_duration_ms", {
      description: "Tool execution duration in milliseconds.",
      unit: "ms",
    }),
    llmRequests: meter.createCounter("agent_llm_requests_total", {
      description: "Total LLM requests.",
    }),
    llmFailures: meter.createCounter("agent_llm_failures_total", {
      description: "Total failed LLM requests.",
    }),
    llmRequestDuration: meter.createHistogram("agent_llm_request_duration_ms", {
      description: "LLM request duration in milliseconds.",
      unit: "ms",
    }),
    acpRequests: meter.createCounter("agent_acp_requests_total", {
      description: "Total ACP requests.",
    }),
    activeAcpRequests: meter.createUpDownCounter("agent_acp_requests_active", {
      description: "Active ACP run requests.",
    }),
    activeInteractiveSessions: meter.createUpDownCounter("agent_interactive_sessions_active", {
      description: "Active interactive CLI sessions.",
    }),
    workflowPhases: meter.createCounter("agent_workflow_phases_total", {
      description: "Total workflow phase events.",
    }),
    doneCriteriaChecks: meter.createCounter("agent_done_criteria_checks_total", {
      description: "Total done criteria checks.",
    }),
  };

  return instruments;
}

function normalizeAttributes(attributes: Attributes): Attributes {
  const normalized: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export async function initTelemetry(): Promise<void> {
  if (initialized || !isTelemetryEnabled()) {
    return;
  }

  initialized = true;

  try {
    const traceExporter = new OTLPTraceExporter({
      url: getOtlpTracesEndpoint(),
    });
    const metricExporter = new OTLPMetricExporter({
      url: getOtlpMetricsEndpoint(),
    });
    const logExporter = new OTLPLogExporter({
      url: getOtlpLogsEndpoint(),
    });

    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: getServiceName(),
        [ATTR_SERVICE_VERSION]: getServiceVersion(),
        "deployment.environment.name": getDeploymentEnvironment(),
        "process.runtime.name": "nodejs",
        "process.runtime.version": process.version,
        "os.type": process.platform,
      }),
      traceExporter,
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
        }),
      ],
      logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
      instrumentations: [],
    });

    sdk.start();
  } catch (error) {
    const message = errorMessage(error, "Unknown telemetry initialization error.");
    console.error(`[telemetry] failed to initialize OpenTelemetry: ${message}`);
    sdk = null;
  }
}

export function getTracer(): Tracer {
  return trace.getTracer(getServiceName(), getServiceVersion());
}

export function getMeter(): Meter {
  return metrics.getMeter(getServiceName(), getServiceVersion());
}

export function getLogger(): Logger {
  return logs.getLogger(getServiceName(), getServiceVersion());
}

export function getActiveTraceId(): string | null {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return traceId && !/^0+$/.test(traceId) ? traceId : null;
}

export function getActiveSpanId(): string | null {
  const spanId = trace.getActiveSpan()?.spanContext().spanId;
  return spanId && !/^0+$/.test(spanId) ? spanId : null;
}

export function emitTelemetryLog(
  eventName: string,
  body: string,
  attributes: Attributes = {},
  severityNumber = SeverityNumber.INFO,
): void {
  getLogger().emit({
    eventName,
    severityNumber,
    severityText: severityNumber >= SeverityNumber.ERROR ? "ERROR" : "INFO",
    body,
    attributes: normalizeAttributes(attributes),
  });
}

export function recordAgentRunStarted(mode: string): void {
  const attrs = { "agent.mode": mode };
  const telemetry = getInstruments();
  telemetry.agentRuns.add(1, attrs);
  telemetry.activeAgentRuns.add(1, attrs);
  emitTelemetryLog("agent_started", "Agent run started.", attrs);
}

export function recordAgentRunCompleted(
  mode: string,
  status: "success" | "error",
  durationMs: number,
): void {
  const attrs = { "agent.mode": mode, status };
  const telemetry = getInstruments();
  telemetry.agentRunDuration.record(durationMs, attrs);
  telemetry.activeAgentRuns.add(-1, { "agent.mode": mode });
  emitTelemetryLog(`agent_${status}`, `Agent run ${status}.`, attrs);
}

export function recordToolMetric(toolName: string, status: Status, durationMs?: number): void {
  const attrs = { "tool.name": toolName, status };
  const telemetry = getInstruments();

  if (status === "started") {
    telemetry.toolCalls.add(1, { "tool.name": toolName });
    return;
  }

  if (durationMs !== undefined) {
    telemetry.toolDuration.record(durationMs, attrs);
  }

  if (status === "error") {
    telemetry.toolFailures.add(1, { "tool.name": toolName });
  }
}

export function recordLlmMetric(
  status: "success" | "error",
  durationMs: number,
  toolsEnabled: boolean,
): void {
  const attrs = { status, "llm.tools_enabled": toolsEnabled };
  const telemetry = getInstruments();
  telemetry.llmRequests.add(1, { "llm.tools_enabled": toolsEnabled });
  telemetry.llmRequestDuration.record(durationMs, attrs);

  if (status === "error") {
    telemetry.llmFailures.add(1, { "llm.tools_enabled": toolsEnabled });
  }
}

export function recordAcpRequestMetric(type: string, status: Status, durationMs?: number): void {
  const attrs = { "acp.type": type, status };
  const telemetry = getInstruments();

  if (status === "started") {
    telemetry.acpRequests.add(1, { "acp.type": type });
    telemetry.activeAcpRequests.add(1, { "acp.type": type });
    return;
  }

  telemetry.activeAcpRequests.add(-1, { "acp.type": type });
  emitTelemetryLog(`acp_${status}`, `ACP request ${status}.`, {
    ...attrs,
    "acp.duration_ms": durationMs ?? 0,
  });
}

export function recordInteractiveSessionMetric(status: "started" | "ended"): void {
  const value = status === "started" ? 1 : -1;
  getInstruments().activeInteractiveSessions.add(value, { mode: "interactive" });
  emitTelemetryLog(`interactive_session_${status}`, `Interactive session ${status}.`, {
    mode: "interactive",
  });
}

export function recordWorkflowPhaseMetric(
  name: string,
  eventType: "started" | "completed" | "verification",
  status?: "passed" | "failed",
): void {
  const attrs = normalizeAttributes({
    "workflow.phase": name,
    "workflow.event": eventType,
    status,
  });
  getInstruments().workflowPhases.add(1, attrs);
  emitTelemetryLog("workflow_phase", "Workflow phase event.", attrs);
}

export function recordDoneCriteriaMetric(name: string, passed: boolean, skipped: boolean): void {
  getInstruments().doneCriteriaChecks.add(1, {
    "done_criteria.name": name,
    status: skipped ? "skipped" : passed ? "passed" : "failed",
  });
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
  } catch (error) {
    const message = errorMessage(error, "Telemetry exporter shutdown failed.");
    console.error(`[telemetry] failed to shutdown OpenTelemetry: ${message}`);
  } finally {
    sdk = null;
    instruments = null;
  }
}
