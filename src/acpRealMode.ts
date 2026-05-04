import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { type AgentEvent, runAgent } from "./agent.js";
import { redactSecretValues } from "./traceLogger.js";

const PROTOCOL_VERSION = 1;
const AGENT_NAME = "terminal-coding-agent";
const AGENT_VERSION = "0.1.0";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: {
        code: number;
        message: string;
      };
    };

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
};

type Session = {
  id: string;
  cwd: string;
  cancelled: boolean;
};

type TextContentBlock = {
  type: "text";
  text: string;
};

type PromptParams = {
  sessionId: string;
  prompt: TextContentBlock[];
};

const sessions = new Map<string, Session>();

function writeJson(value: JsonRpcResponse | JsonRpcNotification): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeJson({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeJson({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: redactSecretValues(message),
    },
  });
}

function writeSessionUpdate(sessionId: string, update: unknown): void {
  writeJson({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update,
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    throw new Error("Invalid JSON-RPC request.");
  }

  if (
    value.id !== undefined &&
    typeof value.id !== "string" &&
    typeof value.id !== "number" &&
    value.id !== null
  ) {
    throw new Error("Invalid JSON-RPC request id.");
  }

  return {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
    params: value.params,
  };
}

function getRequestId(request: JsonRpcRequest): JsonRpcId | undefined {
  return request.id;
}

function getParamsObject(params: unknown): Record<string, unknown> {
  if (!isObject(params)) {
    throw new Error("Expected params object.");
  }

  return params;
}

function handleInitialize(request: JsonRpcRequest): void {
  const params = getParamsObject(request.params);
  const requestedVersion =
    typeof params.protocolVersion === "number" ? params.protocolVersion : PROTOCOL_VERSION;

  writeResult(getRequestId(request) ?? null, {
    protocolVersion: requestedVersion,
    agentCapabilities: {
      loadSession: false,
      mcpCapabilities: {
        http: false,
        sse: false,
      },
      promptCapabilities: {
        audio: false,
        embeddedContext: false,
        image: false,
      },
      sessionCapabilities: {},
    },
    agentInfo: {
      name: AGENT_NAME,
      title: "Terminal Coding Agent",
      version: AGENT_VERSION,
    },
    authMethods: [],
  });
}

function handleSessionNew(request: JsonRpcRequest): void {
  const params = getParamsObject(request.params);

  if (typeof params.cwd !== "string" || params.cwd.trim() === "") {
    throw new Error("session/new requires cwd.");
  }

  const sessionId = `session_${randomUUID()}`;
  sessions.set(sessionId, {
    id: sessionId,
    cwd: params.cwd,
    cancelled: false,
  });

  writeResult(getRequestId(request) ?? null, {
    sessionId,
    modes: null,
    configOptions: null,
  });
}

function parsePromptParams(params: unknown): PromptParams {
  const paramsObject = getParamsObject(params);

  if (typeof paramsObject.sessionId !== "string" || paramsObject.sessionId.trim() === "") {
    throw new Error("session/prompt requires sessionId.");
  }

  if (!Array.isArray(paramsObject.prompt)) {
    throw new Error("session/prompt requires prompt content blocks.");
  }

  const prompt = paramsObject.prompt.map((block) => {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("Only text prompt content blocks are supported in --acp-real.");
    }

    return {
      type: "text" as const,
      text: block.text,
    };
  });

  if (prompt.length === 0 || prompt.every((block) => block.text.trim() === "")) {
    throw new Error("session/prompt requires non-empty text content.");
  }

  return {
    sessionId: paramsObject.sessionId,
    prompt,
  };
}

function getToolKind(toolName: string): string {
  if (toolName === "Read" || toolName === "DocumentSymbols") {
    return "read";
  }

  if (toolName === "Write") {
    return "edit";
  }

  if (toolName === "SearchFiles") {
    return "search";
  }

  if (toolName === "Bash" || toolName === "TypeCheck") {
    return "execute";
  }

  return "think";
}

function createTextBlock(text: string): TextContentBlock {
  return {
    type: "text",
    text: redactSecretValues(text),
  };
}

async function handleSessionPrompt(request: JsonRpcRequest): Promise<void> {
  const params = parsePromptParams(request.params);
  const session = sessions.get(params.sessionId);

  if (!session) {
    throw new Error(`Unknown session: ${params.sessionId}`);
  }

  session.cancelled = false;

  const promptText = params.prompt.map((block) => block.text).join("\n").trim();
  const toolCallIds = new Map<string, string[]>();
  let toolCounter = 0;

  function nextToolCallId(toolName: string): string {
    toolCounter += 1;
    const toolCallId = `${params.sessionId}_tool_${toolCounter}`;
    const existing = toolCallIds.get(toolName) ?? [];
    existing.push(toolCallId);
    toolCallIds.set(toolName, existing);
    return toolCallId;
  }

  function latestToolCallId(toolName: string): string {
    const existing = toolCallIds.get(toolName);
    return existing?.[existing.length - 1] ?? `${params.sessionId}_tool_unknown`;
  }

  function onEvent(event: AgentEvent): void {
    if (event.type === "tool_started") {
      const toolCallId = nextToolCallId(event.toolName);
      writeSessionUpdate(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `${event.toolName} started`,
        kind: getToolKind(event.toolName),
        status: "in_progress",
        rawInput: event.args,
        content: [],
        locations: [],
      });
      return;
    }

    if (event.type === "tool_completed") {
      writeSessionUpdate(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: latestToolCallId(event.toolName),
        status: "completed",
        rawOutput: {
          durationMs: event.durationMs,
        },
      });
      return;
    }

    if (event.type === "tool_error") {
      writeSessionUpdate(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: latestToolCallId(event.toolName),
        status: "failed",
        rawOutput: {
          durationMs: event.durationMs,
          error: redactSecretValues(event.error),
        },
      });
      return;
    }

    if (event.type === "agent_completed") {
      writeSessionUpdate(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: createTextBlock(event.finalAnswer),
      });
    }
  }

  try {
    await runAgent(promptText, { onEvent });

    writeResult(getRequestId(request) ?? null, {
      stopReason: session.cancelled ? "cancelled" : "end_turn",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeSessionUpdate(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: createTextBlock(`Error: ${message}`),
    });
    writeError(getRequestId(request) ?? null, -32603, message);
  }
}

function handleSessionCancel(request: JsonRpcRequest): void {
  const params = getParamsObject(request.params);

  if (typeof params.sessionId !== "string" || params.sessionId.trim() === "") {
    throw new Error("session/cancel requires sessionId.");
  }

  const session = sessions.get(params.sessionId);

  if (session) {
    session.cancelled = true;
  }

  if (request.id !== undefined) {
    writeResult(request.id, null);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    if (request.method === "initialize") {
      handleInitialize(request);
      return;
    }

    if (request.method === "session/new") {
      handleSessionNew(request);
      return;
    }

    if (request.method === "session/prompt") {
      await handleSessionPrompt(request);
      return;
    }

    if (request.method === "session/cancel") {
      handleSessionCancel(request);
      return;
    }

    if (request.id !== undefined) {
      writeError(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (request.id !== undefined) {
      const message = error instanceof Error ? error.message : "Invalid request.";
      writeError(request.id, -32602, message);
    }
  }
}

export async function handleAcpRealMessage(parsed: unknown): Promise<void> {
  let request: JsonRpcRequest;

  try {
    request = parseJsonRpcRequest(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    writeError(null, -32600, message);
    return;
  }

  await handleRequest(request);
}

async function handleLine(line: string): Promise<void> {
  const trimmedLine = line.trim();

  if (!trimmedLine) {
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    writeError(null, -32700, "Parse error.");
    return;
  }

  await handleAcpRealMessage(parsed);
}

export async function runAcpRealMode(): Promise<void> {
  const rl = createInterface({
    input: stdin,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      await handleLine(line);
    }
  } finally {
    rl.close();
  }
}
