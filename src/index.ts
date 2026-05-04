#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { runDocsMode } from "./docsMode.js";
import { runSpecFirst } from "./specFirst.js";
import { runTddMode } from "./tddMode.js";

const DOCS_COMMAND_PREFIX = "/docs";
const SPEC_COMMAND_PREFIX = "/spec";
const TDD_COMMAND_PREFIX = "/tdd";

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

  const prompt = args.slice(promptFlagIndex + 1).join(" ").trim();

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

function printUsage(): void {
  console.error('Usage: npm run dev -- --prompt "your prompt here"');
  console.error('   or: npm run dev -- -p "your prompt here"');
  console.error('   or: npm run dev -- --spec-first --prompt "your task here"');
  console.error('   or: npm run dev -- --tdd --prompt "your task here"');
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

async function runOneShot(prompt: string): Promise<void> {
  const finalAnswer = await runAgent(prompt);
  console.log(finalAnswer);
}

async function runSpecFirstOneShot(task: string): Promise<void> {
  const spec = await runSpecFirst(task);
  console.log(spec);
}

async function runTddOneShot(task: string): Promise<void> {
  const finalAnswer = await runTddMode(task);
  console.log(finalAnswer);
}

async function runDocsOneShot(topic: string): Promise<void> {
  const finalAnswer = await runDocsMode(topic);
  console.log(finalAnswer);
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

async function runInteractiveMode(): Promise<void> {
  const rl = createInterface({ input, output });

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

      const docsTopic = getSlashCommandTask(prompt, DOCS_COMMAND_PREFIX);

      if (docsTopic !== null) {
        if (!docsTopic) {
          console.error("Usage: /docs describe the documentation topic");
          continue;
        }

        try {
          await runDocsOneShot(docsTopic);
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
          await runSpecFirstOneShot(specTask);
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
          await runTddOneShot(tddTask);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Error: ${message}`);
        }

        continue;
      }

      try {
        await runOneShot(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const prompt = getPromptFromArgs(args);
  const specFirst = hasSpecFirstFlag(args);
  const tdd = hasTddFlag(args);

  if (specFirst && tdd) {
    console.error("Use either --spec-first or --tdd, not both.");
    process.exitCode = 1;
    return;
  }

  if (prompt) {
    if (specFirst) {
      await runSpecFirstOneShot(prompt);
      return;
    }

    if (tdd) {
      await runTddOneShot(prompt);
      return;
    }

    await runOneShot(prompt);
    return;
  }

  if (args.length > 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runInteractiveMode();
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
