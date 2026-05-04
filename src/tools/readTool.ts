import { readFile } from "node:fs/promises";
import { PathSafetyError, resolveProjectPath } from "./pathSafety.js";

export async function readTool(filePath: string): Promise<string> {
  try {
    const safePath = resolveProjectPath(filePath);
    return await readFile(safePath, "utf-8");
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown file error";
    throw new Error(`Could not read file "${filePath}": ${message}`);
  }
}
