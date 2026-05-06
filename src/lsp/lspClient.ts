import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LSP_REQUEST_TIMEOUT_MS = 20_000;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type Position = {
  line: number;
  character: number;
};

type Range = {
  start: Position;
  end: Position;
};

type Location = {
  uri: string;
  range: Range;
};

type LocationLink = {
  targetUri: string;
  targetRange: Range;
};

type DocumentSymbol = {
  name: string;
  kind: number;
  range: Range;
  children?: DocumentSymbol[];
};

type SymbolInformation = {
  name: string;
  kind: number;
  location: Location;
};

export type LspDocumentSymbol = {
  name: string;
  kind: string;
  line: number;
  column: number;
  depth: number;
};

export type LspLocation = {
  filePath: string;
  line: number;
  column: number;
};

class JsonRpcConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number | string, PendingRequest>();

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readMessages();
    });

    this.process.on("exit", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeoutId);
        request.reject(new Error("TypeScript language server exited before responding."));
      }

      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolveRequest, rejectRequest) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`LSP request timed out: ${method}`));
      }, LSP_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeoutId,
      });

      this.send(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private send(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    this.process.stdin.write(payload);
  }

  private readMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");

      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length: (\d+)/i);

      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        return;
      }

      const rawMessage = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.handleMessage(JSON.parse(rawMessage) as JsonRpcMessage);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      });
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const request = this.pending.get(message.id);

    if (!request) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(request.timeoutId);

    if (message.error) {
      request.reject(new Error(message.error.message));
      return;
    }

    request.resolve(message.result);
  }
}

class LspSession {
  private readonly connection: JsonRpcConnection;
  private readonly openDocuments = new Set<string>();
  private initialized = false;

  constructor(
    private readonly projectRoot: string,
    private readonly serverProcess: ChildProcessWithoutNullStreams,
  ) {
    this.connection = new JsonRpcConnection(serverProcess);
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootUri = pathToFileURL(`${this.projectRoot}${sep}`).toString();

    await this.connection.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          definition: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          references: {},
        },
      },
      workspaceFolders: [
        {
          uri: rootUri,
          name: basename(this.projectRoot),
        },
      ],
    });

    this.connection.notify("initialized", {});
    this.initialized = true;
  }

  async ensureDocumentOpen(absoluteFilePath: string): Promise<string> {
    await this.ensureInitialized();

    const fileUri = pathToFileURL(absoluteFilePath).toString();

    if (this.openDocuments.has(fileUri)) {
      return fileUri;
    }

    const fileText = await readFile(absoluteFilePath, "utf8");

    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId: getLanguageId(absoluteFilePath),
        version: 1,
        text: fileText,
      },
    });
    this.openDocuments.add(fileUri);

    return fileUri;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureInitialized();
    return this.connection.request(method, params);
  }

  async shutdown(): Promise<void> {
    try {
      await this.connection.request("shutdown", null);
    } catch {
      // Best effort cleanup only.
    }

    this.connection.notify("exit");
    this.serverProcess.kill();
  }
}

const sessions = new Map<string, LspSession>();

function getLanguageServerPath(projectRoot: string): string {
  const serverPath = join(
    projectRoot,
    "node_modules",
    "typescript-language-server",
    "lib",
    "cli.mjs",
  );

  if (!existsSync(serverPath)) {
    throw new Error(
      "TypeScript language server is not installed. Run npm install before using LSP tools.",
    );
  }

  return serverPath;
}

function createSession(projectRoot: string): LspSession {
  const serverPath = getLanguageServerPath(projectRoot);
  const serverProcess = spawn(process.execPath, [serverPath, "--stdio"], {
    cwd: projectRoot,
    stdio: "pipe",
  });

  return new LspSession(projectRoot, serverProcess);
}

function getSession(projectRoot: string): LspSession {
  const existing = sessions.get(projectRoot);

  if (existing) {
    return existing;
  }

  const session = createSession(projectRoot);
  sessions.set(projectRoot, session);

  return session;
}

export async function shutdownTypeScriptLanguageServer(): Promise<void> {
  const activeSessions = [...sessions.values()];
  sessions.clear();
  await Promise.all(activeSessions.map((session) => session.shutdown()));
}

process.once("exit", () => {
  for (const session of sessions.values()) {
    void session.shutdown();
  }
});

process.once("SIGINT", () => {
  void shutdownTypeScriptLanguageServer().finally(() => process.exit(130));
});

function getLanguageId(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".tsx") {
    return "typescriptreact";
  }

  if (extension === ".js") {
    return "javascript";
  }

  if (extension === ".jsx") {
    return "javascriptreact";
  }

  return "typescript";
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };

  return names[kind] ?? "Symbol";
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  depth = 0,
): LspDocumentSymbol[] {
  return symbols.flatMap((symbol) => [
    {
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      line: symbol.range.start.line + 1,
      column: symbol.range.start.character + 1,
      depth,
    },
    ...flattenDocumentSymbols(symbol.children ?? [], depth + 1),
  ]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  const symbol = value as Partial<DocumentSymbol>;

  return (
    isObject(value) &&
    typeof symbol.name === "string" &&
    typeof symbol.kind === "number" &&
    isObject(symbol.range)
  );
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
  const symbol = value as Partial<SymbolInformation>;

  return (
    isObject(value) &&
    typeof symbol.name === "string" &&
    typeof symbol.kind === "number" &&
    isObject(symbol.location)
  );
}

function isLocation(value: unknown): value is Location {
  const location = value as Partial<Location>;

  return isObject(value) && typeof location.uri === "string" && isObject(location.range);
}

function isLocationLink(value: unknown): value is LocationLink {
  const location = value as Partial<LocationLink>;

  return isObject(value) && typeof location.targetUri === "string" && isObject(location.targetRange);
}

function normalizeDocumentSymbols(result: unknown): LspDocumentSymbol[] {
  if (!Array.isArray(result)) {
    return [];
  }

  if (result.every(isDocumentSymbol)) {
    return flattenDocumentSymbols(result);
  }

  if (result.every(isSymbolInformation)) {
    return result.map((symbol) => ({
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      line: symbol.location.range.start.line + 1,
      column: symbol.location.range.start.character + 1,
      depth: 0,
    }));
  }

  return [];
}

function locationToResult(projectRoot: string, uri: string, range: Range): LspLocation {
  const absolutePath = fileURLToPath(uri);

  return {
    filePath: relative(projectRoot, absolutePath).split(sep).join("/"),
    line: range.start.line + 1,
    column: range.start.character + 1,
  };
}

function normalizeLocations(projectRoot: string, result: unknown): LspLocation[] {
  if (!result) {
    return [];
  }

  const values = Array.isArray(result) ? result : [result];

  return values.flatMap((value) => {
    if (isLocation(value)) {
      return [locationToResult(projectRoot, value.uri, value.range)];
    }

    if (isLocationLink(value)) {
      return [locationToResult(projectRoot, value.targetUri, value.targetRange)];
    }

    return [];
  });
}

async function getPreparedSession(absoluteFilePath: string): Promise<{
  projectRoot: string;
  session: LspSession;
  fileUri: string;
}> {
  const projectRoot = resolve(process.cwd());
  const session = getSession(projectRoot);
  const fileUri = await session.ensureDocumentOpen(absoluteFilePath);

  return {
    projectRoot,
    session,
    fileUri,
  };
}

function toLspPosition(line: number, column: number): Position {
  return {
    line: line - 1,
    character: column - 1,
  };
}

export async function getTypeScriptDocumentSymbols(
  absoluteFilePath: string,
): Promise<LspDocumentSymbol[]> {
  const { session, fileUri } = await getPreparedSession(absoluteFilePath);
  const result = await session.request("textDocument/documentSymbol", {
    textDocument: {
      uri: fileUri,
    },
  });

  return normalizeDocumentSymbols(result);
}

export async function getTypeScriptDefinition(
  absoluteFilePath: string,
  line: number,
  column: number,
): Promise<LspLocation[]> {
  const { projectRoot, session, fileUri } = await getPreparedSession(absoluteFilePath);
  const result = await session.request("textDocument/definition", {
    textDocument: {
      uri: fileUri,
    },
    position: toLspPosition(line, column),
  });

  return normalizeLocations(projectRoot, result);
}

export async function getTypeScriptReferences(
  absoluteFilePath: string,
  line: number,
  column: number,
): Promise<LspLocation[]> {
  const { projectRoot, session, fileUri } = await getPreparedSession(absoluteFilePath);
  const result = await session.request("textDocument/references", {
    textDocument: {
      uri: fileUri,
    },
    position: toLspPosition(line, column),
    context: {
      includeDeclaration: true,
    },
  });

  return normalizeLocations(projectRoot, result);
}
