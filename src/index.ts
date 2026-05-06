#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runAcpMode } from "./acpMode.js";
import { runAcpRealMode } from "./acpRealMode.js";
import { runAgent, runAgentWithMessages } from "./agent.js";
import {
  formatDoneCriteriaResult,
  runDoneCriteria,
} from "./doneCriteria.js";
import { buildDocsPrompt, runDocsMode } from "./docsMode.js";
import { type ChatMessage } from "./llmClient.js";
import {
  type SecurityOptions,
  type ToolApprovalRequest,
} from "./securityPolicy.js";
import { buildSpecPrompt, runSpecFirst } from "./specFirst.js";
import { buildTddPrompt, runTddMode } from "./tddMode.js";
import {
  initTelemetry,
  recordInteractiveSessionMetric,
  shutdownTelemetry,
} from "./telemetry.js";
import { shutdownTypeScriptLanguageServer } from "./lsp/lspClient.js";

const DOCS_COMMAND_PREFIX = "/docs";
const HISTORY_COMMAND = "/history";
const MAX_INTERACTIVE_MESSAGES = 30;
const RESET_COMMAND = "/reset";
const SPEC_COMMAND_PREFIX = "/spec";
const TDD_COMMAND_PREFIX = "/tdd";
const SECURITY_FLAGS = new Set([
  "--yes",
  "--deny-tools",
  "--allow-bash",
  "--allow-sensitive-read",
]);

function getPromptFromArgs(args: string[]): string | null {
  const promptWithEquals = args.find((arg) => arg.startsWith("--prompt="));

  if (promptWithEquals) {
    const prompt = promptWithEquals.slice("--prompt=".length).trim();
    return prompt || null;
  }

  const promptFlagIndex = args.findIndex((arg) => arg === "-p" || arg === "--prompt");

  if (promptFlagIndex === -1) {
    return null;
  }

  const promptParts = args
    .slice(promptFlagIndex + 1)
    .filter((arg) => !SECURITY_FLAGS.has(arg));
  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    return null;
  }

  return prompt;
}

function hasSpecFirstFlag(args: string[]): boolean {
  return args.includes("--spec-first");
}

function hasTddFlag(args: string[]): boolean {
  return args.includes("--tdd");
}

function hasAcpFlag(args: string[]): boolean {
  return args.includes("--acp");
}

function hasAcpRealFlag(args: string[]): boolean {
  return args.includes("--acp-real");
}

function hasYesFlag(args: string[]): boolean {
  return args.includes("--yes");
}

function hasDenyToolsFlag(args: string[]): boolean {
  return args.includes("--deny-tools");
}

function hasAllowBashFlag(args: string[]): boolean {
  return args.includes("--allow-bash");
}

function hasAllowSensitiveReadFlag(args: string[]): boolean {
  return args.includes("--allow-sensitive-read");
}

function hasOnlySecurityFlags(args: string[]): boolean {
  return args.every((arg) => SECURITY_FLAGS.has(arg));
}

function printUsage(): void {
  console.error('Usage: npm run dev -- --prompt "your prompt here"');
  console.error('   or: npm run dev -- -p "your prompt here"');
  console.error('   or: npm run dev -- --spec-first --prompt "your task here"');
  console.error('   or: npm run dev -- --tdd --prompt "your task here"');
  console.error("   or: npm run dev -- --acp");
  console.error("   or: npm run dev -- --acp-real");
  console.error("Security flags: --yes --allow-bash --allow-sensitive-read --deny-tools");
}

function isExitCommand(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

function isClearCommand(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "clear" || normalized === "cls";
}

function clearTerminal(): void {
  console.clear();
}

function isResetCommand(value: string): boolean {
  return value.trim().toLowerCase() === RESET_COMMAND;
}

function isHistoryCommand(value: string): boolean {
  return value.trim().toLowerCase() === HISTORY_COMMAND;
}

function trimInteractiveMessages(messages: ChatMessage[]): void {
  if (messages.length <= MAX_INTERACTIVE_MESSAGES) {
    return;
  }

  const securityMessage = messages[0]?.role === "system" ? messages[0] : null;

  messages.splice(0, messages.length - MAX_INTERACTIVE_MESSAGES);

  while (messages.length > 0 && messages[0].role !== "user") {
    messages.shift();
  }

  if (securityMessage && messages[0] !== securityMessage) {
    messages.unshift(securityMessage);
  }
}

async function runOneShot(prompt: string, security: SecurityOptions): Promise<void> {
  const finalAnswer = await runAgent(prompt, { security });
  console.log(finalAnswer);
}

async function runSpecFirstOneShot(task: string, security: SecurityOptions): Promise<void> {
  const spec = await runSpecFirst(task, security);
  console.log(spec);
}

async function runTddOneShot(task: string, security: SecurityOptions): Promise<void> {
  const finalAnswer = await runTddMode(task, security);
  console.log(finalAnswer);
}

async function runDocsOneShot(topic: string, security: SecurityOptions): Promise<void> {
  const finalAnswer = await runDocsMode(topic, security);
  console.log(finalAnswer);
}

function createBaseSecurityOptions(args: string[]): SecurityOptions {
  return {
    autoApprove: hasYesFlag(args),
    denyMutatingTools: hasDenyToolsFlag(args),
    allowBash: hasAllowBashFlag(args),
    allowSensitiveRead: hasAllowSensitiveReadFlag(args),
  };
}

function formatApprovalDetails(request: ToolApprovalRequest): string {
  return Object.entries(request.details)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function createInteractiveApprovalHandler(
  rl: ReturnType<typeof createInterface>,
): SecurityOptions["approvalHandler"] {
  return async (request) => {
    const details = formatApprovalDetails(request);
    const answer = await rl.question(
      `[approval] ${request.toolName} requested. ${request.reason} ${details} Approve? (y/N) `,
    );
    const normalized = answer.trim().toLowerCase();

    return normalized === "y" || normalized === "yes";
  };
}

async function runInteractiveAgentTurn(
  messages: ChatMessage[],
  prompt: string,
  agentPrompt = prompt,
  security: SecurityOptions = {},
  options: {
    maxSteps?: number | null;
    mode?: "interactive" | "tdd" | "docs";
  } = {},
): Promise<string> {
  const messageCountBeforeRun = messages.length;

  messages.push({
    role: "user",
    content: agentPrompt,
  });

  try {
    const finalAnswer = await runAgentWithMessages(messages, {
      maxSteps: options.maxSteps,
      mode: options.mode ?? "interactive",
      promptForRecord: prompt,
      conversationMessageCountBeforeRun: messageCountBeforeRun,
      security,
    });

    trimInteractiveMessages(messages);
    return finalAnswer;
  } catch (error) {
    messages.splice(messageCountBeforeRun);
    throw error;
  }
}

async function runInteractiveSpecTurn(
  messages: ChatMessage[],
  task: string,
  security: SecurityOptions,
): Promise<string> {
  const messageCountBeforeRun = messages.length;

  messages.push({
    role: "user",
    content: buildSpecPrompt(task),
  });

  try {
    const content = await runAgentWithMessages(messages, {
      mode: "spec-first",
      includeTools: false,
      promptForRecord: task,
      conversationMessageCountBeforeRun: messageCountBeforeRun,
      security,
    });
    trimInteractiveMessages(messages);
    return content;
  } catch (error) {
    messages.splice(messageCountBeforeRun);
    throw error;
  }
}

async function runInteractiveTddTurn(
  messages: ChatMessage[],
  task: string,
  security: SecurityOptions,
): Promise<string> {
  const agentSummary = await runInteractiveAgentTurn(
    messages,
    task,
    buildTddPrompt(task),
    security,
    {
      maxSteps: null,
      mode: "tdd",
    },
  );
  const doneCriteria = await runDoneCriteria(agentSummary);
  const doneCriteriaReport = formatDoneCriteriaResult(doneCriteria);

  if (!doneCriteria.passed) {
    return `${agentSummary}

${doneCriteriaReport}

Status: NOT DONE. One or more required verification checks failed.`;
  }

  return `${agentSummary}

${doneCriteriaReport}`;
}

function getSlashCommandTask(prompt: string, commandPrefix: string): string | null {
  if (prompt === commandPrefix) {
    return "";
  }

  if (!prompt.startsWith(`${commandPrefix} `)) {
    return null;
  }

  return prompt.slice(commandPrefix.length).trim();
}

async function runInteractiveMode(security: SecurityOptions): Promise<void> {
  const rl = createInterface({ input, output });
  const messages: ChatMessage[] = [];
  const interactiveSecurity: SecurityOptions = {
    ...security,
    approvalHandler: security.autoApprove
      ? security.approvalHandler
      : createInteractiveApprovalHandler(rl),
  };

  recordInteractiveSessionMetric("started");

  try {
    while (true) {
      const userInput = await rl.question("agent> ");
      const prompt = userInput.trim();

      if (prompt === "") {
        continue;
      }

      if (isExitCommand(prompt)) {
        return;
      }

      if (isClearCommand(prompt)) {
        clearTerminal();
        continue;
      }

      if (isResetCommand(prompt)) {
        messages.length = 0;
        console.log("Conversation memory cleared.");
        continue;
      }

      if (isHistoryCommand(prompt)) {
        console.log(`Conversation memory contains ${messages.length} message(s).`);
        continue;
      }

      const docsTopic = getSlashCommandTask(prompt, DOCS_COMMAND_PREFIX);

      if (docsTopic !== null) {
        if (!docsTopic) {
          console.error("Usage: /docs describe the documentation topic");
          continue;
        }

        try {
          const finalAnswer = await runInteractiveAgentTurn(
            messages,
            docsTopic,
            buildDocsPrompt(docsTopic),
            interactiveSecurity,
            {
              mode: "docs",
            },
          );
          console.log(finalAnswer);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Error: ${message}`);
        }

        continue;
      }

      const specTask = getSlashCommandTask(prompt, SPEC_COMMAND_PREFIX);

      if (specTask !== null) {
        if (!specTask) {
          console.error("Usage: /spec describe the task");
          continue;
        }

        try {
          const spec = await runInteractiveSpecTurn(messages, specTask, interactiveSecurity);
          console.log(spec);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Error: ${message}`);
        }

        continue;
      }

      const tddTask = getSlashCommandTask(prompt, TDD_COMMAND_PREFIX);

      if (tddTask !== null) {
        if (!tddTask) {
          console.error("Usage: /tdd describe the task");
          continue;
        }

        try {
          const finalAnswer = await runInteractiveTddTurn(messages, tddTask, interactiveSecurity);
          console.log(finalAnswer);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Error: ${message}`);
        }

        continue;
      }

      try {
        const finalAnswer = await runInteractiveAgentTurn(
          messages,
          prompt,
          prompt,
          interactiveSecurity,
        );
        console.log(finalAnswer);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
      }
    }
  } finally {
    recordInteractiveSessionMetric("ended");
    rl.close();
  }
}

async function main(): Promise<void> {
  await initTelemetry();

  const args = process.argv.slice(2);
  const prompt = getPromptFromArgs(args);
  const acp = hasAcpFlag(args);
  const acpReal = hasAcpRealFlag(args);
  const stdinIsPiped = input.isTTY !== true;
  const specFirst = hasSpecFirstFlag(args);
  const tdd = hasTddFlag(args);
  const security = createBaseSecurityOptions(args);

  if (acpReal) {
    await runAcpRealMode(security);
    return;
  }

  if (acp || (stdinIsPiped && !prompt)) {
    await runAcpMode(security);
    return;
  }

  if (specFirst && tdd) {
    console.error("Use either --spec-first or --tdd, not both.");
    process.exitCode = 1;
    return;
  }

  if (prompt) {
    if (specFirst) {
      await runSpecFirstOneShot(prompt, security);
      return;
    }

    if (tdd) {
      await runTddOneShot(prompt, security);
      return;
    }

    await runOneShot(prompt, security);
    return;
  }

  if (args.length > 0 && !hasOnlySecurityFlags(args)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runInteractiveMode(security);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Error: ${message}`);
  process.exitCode = 1;
} finally {
  await shutdownTypeScriptLanguageServer();
  await shutdownTelemetry();
}
