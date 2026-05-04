# Terminal Coding Agent

A minimal TypeScript/Node.js CLI project for a final-year B.Tech CSE capstone.

The long-term goal is to build a terminal-based AI coding assistant that can talk
to an LLM through a REST API, advertise local tools through JSON schemas, execute
tools, and run a simple agent loop.

## Current Scope

The project currently includes:

- TypeScript configuration
- Node.js CLI entry point
- npm scripts for development and build
- Basic LLM communication through a REST API
- Read, Write, Bash, SearchFiles, and TypeCheck tool schemas advertised to the LLM
- A simple agent loop that can execute Read, Write, Bash, SearchFiles, and TypeCheck tool calls
- Tool trace logging for capstone-friendly observability

The Bash tool includes a timeout and basic safety checks for obviously dangerous
commands. Tool traces are written to stderr so stdout stays reserved for the
final assistant answer.

## Project Structure

```text
terminal-coding-agent/
  src/
    tools/
      bashTool.ts
      pathSafety.ts
      readTool.ts
      searchFilesTool.ts
      schemas.ts
      typeCheckTool.ts
      writeTool.ts
    diagnostics/
      typescriptDiagnostics.ts
    agent.ts
    blackBoxRecorder.ts
    doneCriteria.ts
    docsMode.ts
    index.ts
    llmClient.ts
    specFirst.ts
    tddMode.ts
    traceLogger.ts
  package.json
  tsconfig.json
  README.md
```

## Setup

Install dependencies:

```bash
npm install
```

## Environment Variables

Set these values before running the CLI:

```bash
LLM_API_URL=https://your-llm-api-endpoint
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
```

PowerShell example:

```powershell
$env:LLM_API_URL="https://your-llm-api-endpoint"
$env:LLM_API_KEY="your-api-key"
$env:LLM_MODEL="your-model-name"
```

## Run In Development

```bash
npm run dev -- --prompt "Explain TypeScript in one sentence"
```

Short flag:

```bash
npm run dev -- -p "Explain TypeScript in one sentence"
```

Spec-first mode creates a short implementation spec without advertising tools or
modifying files:

```powershell
npm run dev -- --spec-first --prompt "Add a Format tool that runs prettier"
```

Interactive spec-first command:

```text
agent> /spec Add a Format tool that runs prettier
```

Expected sections:

```text
1. Requirement summary
2. Assumptions
3. Edge cases
4. Files likely affected
5. Test plan
6. Confirmation question
```

TDD mode asks the agent to inspect files, create or update tests first, run
verification, implement the smallest change, and verify again:

```powershell
npm run dev -- --tdd --prompt "Add tests for path sandbox behavior"
```

Interactive TDD command:

```text
agent> /tdd Add tests for path sandbox behavior
```

If no test framework exists, the agent should explain that and use TypeCheck as
a fallback only when it fits the task.

TDD mode also runs a done-criteria harness before reporting completion:

```text
Done criteria: PASSED
- TypeCheck: PASSED - npm run typecheck passed.
- Tests: SKIPPED - No real npm test script found in package.json.
- Final summary: PASSED - Final summary was generated.
```

If a required check fails, the final answer reports `Done criteria: FAILED` and
marks the task as not done.

DocuBuddy documentation mode is available in interactive mode:

```text
agent> /docs architecture of the agent loop and tools
```

It uses SearchFiles and Read to inspect relevant files, then writes Markdown
documentation to `docs/generated-architecture.md` by default. It can include
Mermaid diagrams:

````text
```mermaid
flowchart TD
  CLI["CLI"] --> Agent["Agent loop"]
```
````

The terminal output stays short and confirms which files were inspected and
where the generated documentation was saved.

Phase 9 adds a minimal real LSP integration through the `DocumentSymbols` tool.
It starts `typescript-language-server`, opens the requested file, and asks the
server for `textDocument/documentSymbol` results.

Example:

```text
agent> Use DocumentSymbols on src/agent.ts and summarize the main functions.
```

This is intentionally the first small LSP-backed capability. TypeCheck and the
existing LSP-lite diagnostics remain unchanged.

ACP-like JSON protocol mode is available with `--acp`. In this mode the app
reads newline-delimited JSON requests from stdin and writes JSON events to
stdout. Tool traces and debug logs remain on stderr.

Input:

```json
{"type":"run","id":"req_1","prompt":"Say hello in one short sentence."}
```

Output:

```json
{"type":"started","id":"req_1"}
{"type":"agent_event","id":"req_1","event":{"type":"agent_started","prompt":"Say hello in one short sentence."}}
{"type":"agent_event","id":"req_1","event":{"type":"agent_completed","finalAnswer":"Hello!"}}
{"type":"completed","id":"req_1","finalAnswer":"Hello!"}
```

PowerShell test:

```powershell
'{"type":"run","id":"req_1","prompt":"Say hello in one short sentence."}' | npm run --silent dev -- --acp
```

Use `npm run --silent` for ACP tests so npm does not print its own script
header into stdout. When stdin is piped and no `--prompt` is provided, the app
also treats the input as ACP JSON lines.

ACP mode also streams structured agent events while a request is running:

- `agent_started`
- `tool_started`
- `tool_completed`
- `tool_error`
- `agent_completed`
- `agent_error`

Tool event arguments are sanitized and do not include full file contents, Write
contents, API keys, or hidden model reasoning.

ACP mode also supports session commands:

```json
{"type":"ping","id":"p1"}
```

returns:

```json
{"type":"pong","id":"p1"}
```

```json
{"type":"capabilities","id":"c1"}
```

returns:

```json
{"type":"capabilities_result","id":"c1","capabilities":{"tools":["Read","Write","Bash","SearchFiles","TypeCheck","DocumentSymbols"],"modes":["one-shot","interactive","spec-first","tdd","docs","acp"],"supportsStreamingEvents":true}}
```

Real ACP compatibility mode is available separately:

```powershell
npm run --silent dev -- --acp-real
```

This mode uses JSON-RPC 2.0 messages and keeps the internal `--acp` JSON-lines
mode unchanged. The first supported real-ACP methods are:

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`

The adapter maps agent tool events to `session/update` notifications and returns
`stopReason: "end_turn"` when the prompt finishes. Unsupported official ACP
features, such as loading old sessions, real cancellation, image/audio prompt
blocks, permission requests, and client filesystem/terminal methods, are future
work.

If stdin is piped and the input message has `jsonrpc: "2.0"`, the app also
routes it to the real ACP compatibility layer automatically.

## Observability Stack

The Docker Compose observability stack includes:

- OpenTelemetry Collector
- Jaeger
- Grafana
- Grafana Tempo

Start the stack:

```powershell
docker compose -f observability/docker-compose.yml up -d
```

Check containers:

```powershell
docker compose -f observability/docker-compose.yml ps
```

View collector logs:

```powershell
docker compose -f observability/docker-compose.yml logs -f otel-collector
```

Stop the stack:

```powershell
docker compose -f observability/docker-compose.yml down
```

Local endpoints:

```text
OpenTelemetry Collector OTLP gRPC: http://localhost:4317
OpenTelemetry Collector OTLP HTTP: http://localhost:4318
Jaeger UI: http://localhost:16686
Grafana: http://localhost:3000
```

Grafana uses the default development login:

```text
admin / admin
```

When `OTEL_ENABLED=true`, the app exports OpenTelemetry traces to the collector.
The current trace hierarchy is:

```text
agent.run
  llm.request
  tool.Read
  tool.Write
  tool.Bash
  tool.SearchFiles
  tool.TypeCheck
  tool.LSP
```

Span attributes only store safe metadata such as lengths, durations, tool names,
file paths, search queries, and redacted shell commands.

Each local black-box recorder file in `runs/` includes a `traceId` field. When
an OpenTelemetry trace is active, use that value to find the matching trace:

```text
Jaeger: http://localhost:16686
Grafana: Explore -> Tempo -> TraceID query
```

If telemetry is disabled, `traceId` is `null`.

## Build And Run

Compile TypeScript:

```bash
npm run build
```

Run the compiled CLI:

```bash
npm start -- --prompt "Explain Node.js in one sentence"
```

## Test The Setup

Check that TypeScript compiles:

```bash
npm run typecheck
```

Check that the CLI can call your configured LLM:

```bash
npm run dev -- --prompt "Say hello in one short sentence"
```

Check that the LLM can see the advertised tools:

```bash
npm run dev -- --prompt "What tools are available to you?"
```

The program advertises Read, Write, Bash, SearchFiles, and TypeCheck, executes
requested tool calls, appends tool results to the conversation, and continues
until the model returns a final answer.

## Project Sandbox

Read and Write resolve paths relative to the current project root
(`process.cwd()`). They allow normal project paths such as `README.md`,
`package.json`, and `src/index.ts`, but block paths that escape the project root
with `../` or unsafe absolute paths outside the project.

Create a sample file:

```powershell
"Hello from sample file" | Set-Content sample.txt
```

Ask the model to use Read:

```powershell
npm run dev -- --prompt "Read sample.txt and tell me what it says."
```

Expected result:

```text
The file says: Hello from sample file
```

Find files when you do not know the exact path:

```powershell
npm run dev -- --prompt "Use SearchFiles to find traceLogger.ts, then Read the matching file and list its exported functions."
```

Expected behavior:

```text
SearchFiles finds src/traceLogger.ts, then Read uses that path.
```

Create or overwrite a file with Write:

```powershell
npm run dev -- --prompt "Create a file named notes.txt containing: Hello from Write tool"
```

Check the file:

```powershell
Get-Content notes.txt
```

Expected file contents:

```text
Hello from Write tool
```

Run a command with Bash:

```powershell
npm run dev -- --prompt "Use Bash to run: echo hello"
```

Expected final answer:

```text
The command printed: hello
```

Test command failure handling:

```powershell
npm run dev -- --prompt "Use Bash to run a command that does not exist."
```

Run TypeScript typechecking through the agent:

```powershell
npm run dev -- --prompt "Use TypeCheck to check the project and summarize the result."
```

TypeCheck runs:

```powershell
npm run typecheck
```

When TypeScript errors exist, TypeCheck returns both raw compiler output and a
structured diagnostics section:

```text
Structured diagnostics:
- src/agent.ts:42:12 - Type error: Type 'string | null' is not assignable to type 'string'.
```

Test safety checks:

```powershell
npm run dev -- --prompt "Use Bash to run rm -rf ."
```

Trace logging appears on stderr when tools run. For example:

```text
[tool] 2026-04-29T18:30:12.000Z Read started {"file_path":"README.md"}
[tool] 2026-04-29T18:30:12.025Z Read success 25ms
```

Write traces log content length instead of file contents:

```text
[tool] 2026-04-29T18:31:00.000Z Write started {"file_path":"notes.txt","content_length":21}
```

To keep only the final answer in a file:

```powershell
npm run dev -- --prompt "Say hello" > answer.txt
```

## Black Box Recorder

Each agent run writes a structured JSON record into `runs/`. Records include the
timestamp, mode, sanitized prompt, tool calls, sanitized arguments, short result
summaries, files read and written, Bash commands, TypeCheck summaries, final
answer, and errors.

The recorder does not store API keys, hidden model reasoning, full file contents,
or full Write content. The `runs/` directory is ignored by git.

Example:

```powershell
npm run dev -- --prompt "Use TypeCheck and summarize diagnostics"
Get-ChildItem runs
```
