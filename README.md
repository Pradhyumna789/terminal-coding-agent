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
- Read, Write, and Bash tool schemas advertised to the LLM
- A simple agent loop that can execute Read, Write, and Bash tool calls
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
      readTool.ts
      schemas.ts
      writeTool.ts
    agent.ts
    index.ts
    llmClient.ts
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

The program advertises Read, Write, and Bash, executes requested tool calls,
appends tool results to the conversation, and continues until the model returns a
final answer.

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
