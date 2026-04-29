import { readFile } from "node:fs/promises";

export async function readTool(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown file error";
    throw new Error(`Could not read file "${filePath}": ${message}`);
  }
}
