# Terminal Coding Agent

A minimal TypeScript/Node.js CLI project for a final-year B.Tech CSE capstone.

The long-term goal is to build a terminal-based AI coding assistant that can talk
to an LLM through a REST API, advertise local tools through JSON schemas, execute
tools, and run a simple agent loop.

## Stage 0 Scope

This stage only sets up the project foundation:

- TypeScript configuration
- Node.js CLI entry point
- npm scripts for development and build
- Basic placeholder CLI output

LLM communication, local tools, and the agent loop are intentionally not
implemented yet.

## Project Structure

```text
terminal-coding-agent/
  src/
    index.ts
  package.json
  tsconfig.json
  README.md
```

## Setup

Install dependencies:

```bash
npm install
```

## Run In Development

```bash
npm run dev
```

Expected output:

```text
Terminal Coding Agent
Stage 0: TypeScript CLI setup is working.
```

## Build And Run

Compile TypeScript:

```bash
npm run build
```

Run the compiled CLI:

```bash
npm start
```

## Test The Setup

For Stage 0, testing means checking that TypeScript compiles and the CLI starts:

```bash
npm run typecheck
npm run dev
```
