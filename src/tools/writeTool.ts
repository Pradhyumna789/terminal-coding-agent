import { writeFile } from "node:fs/promises";

export async function writeTool(filePath: string, content: string): Promise<string> {
  try {
    await writeFile(filePath, content, "utf-8");
    return `Wrote file: ${filePath}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown file error";
    throw new Error(`Could not write file "${filePath}": ${message}`);
  }
}
