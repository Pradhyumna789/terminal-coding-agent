#!/usr/bin/env node

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

async function main(): Promise<void> {
  const prompt = getPromptFromArgs(process.argv.slice(2));

  if (!prompt) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const finalAnswer = await runAgent(prompt);
    console.log(finalAnswer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

await main();
