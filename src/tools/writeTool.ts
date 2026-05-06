import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PathSafetyError, resolveWritableProjectPath } from "./pathSafety.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeTool(filePath: string, content: string): Promise<string> {
  try {
    const safePath = await resolveWritableProjectPath(filePath);
    const existed = await pathExists(safePath);

    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf-8");
    return `${existed ? "Overwrote" : "Created"} file: ${filePath}`;
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown file error";
    throw new Error(`Could not write file "${filePath}": ${message}`);
  }
}
