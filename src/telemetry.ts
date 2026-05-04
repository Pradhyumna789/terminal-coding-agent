import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const DEFAULT_SERVICE_NAME = "terminal-coding-agent";
const DEFAULT_SERVICE_VERSION = "0.1.0";
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

let sdk: NodeSDK | null = null;
let initialized = false;

function isTelemetryEnabled(): boolean {
  return process.env.OTEL_ENABLED === "true";
}

function getServiceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
}

function getOtlpEndpoint(): string {
  return (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || DEFAULT_OTLP_ENDPOINT
  );
}

export async function initTelemetry(): Promise<void> {
  if (initialized || !isTelemetryEnabled()) {
    return;
  }

  initialized = true;

  try {
    const traceExporter = new OTLPTraceExporter({
      url: getOtlpEndpoint(),
    });

    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: getServiceName(),
        [ATTR_SERVICE_VERSION]: DEFAULT_SERVICE_VERSION,
      }),
      traceExporter,
      instrumentations: [],
    });

    sdk.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[telemetry] failed to initialize OpenTelemetry: ${message}`);
    sdk = null;
  }
}

export function getTracer(): Tracer {
  return trace.getTracer(getServiceName(), DEFAULT_SERVICE_VERSION);
}

export function getActiveTraceId(): string | null {
  return trace.getActiveSpan()?.spanContext().traceId ?? null;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[telemetry] failed to shutdown OpenTelemetry: ${message}`);
  } finally {
    sdk = null;
  }
}
