import { writeFile } from "node:fs/promises";
import { PathSafetyError, resolveProjectPath } from "./pathSafety.js";

export async function writeTool(filePath: string, content: string): Promise<string> {
  try {
    const safePath = resolveProjectPath(filePath);
    await writeFile(safePath, content, "utf-8");
    return `Wrote file: ${filePath}`;
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown file error";
    throw new Error(`Could not write file "${filePath}": ${message}`);
  }
}
