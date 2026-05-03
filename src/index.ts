#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";

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

function printUsage(): void {
  console.error('Usage: npm run dev -- --prompt "your prompt here"');
  console.error('   or: npm run dev -- -p "your prompt here"');
}

function isExitCommand(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

async function runOneShot(prompt: string): Promise<void> {
  const finalAnswer = await runAgent(prompt);
  console.log(finalAnswer);
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

  if (prompt) {
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
