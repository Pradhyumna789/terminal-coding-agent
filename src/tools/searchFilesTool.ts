import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules", ".vscode", ".idea"]);
const IGNORED_FILE_NAMES = new Set([".env", "notes.txt", "interactive-notes.txt"]);

function isIgnoredFile(fileName: string): boolean {
  return (
    IGNORED_FILE_NAMES.has(fileName) ||
    fileName.endsWith(".log") ||
    fileName.startsWith(".env.") ||
    (fileName.startsWith("sample") && fileName.endsWith(".txt"))
  );
}

function toRelativePath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split(sep).join("/");
}

async function collectMatchingFiles(
  directory: string,
  projectRoot: string,
  normalizedQuery: string,
  matches: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectMatchingFiles(fullPath, projectRoot, normalizedQuery, matches);
      }

      continue;
    }

    if (!entry.isFile() || isIgnoredFile(entry.name)) {
      continue;
    }

    const relativePath = toRelativePath(projectRoot, fullPath);
    const normalizedPath = relativePath.toLowerCase();
    const normalizedName = basename(relativePath).toLowerCase();

    if (normalizedPath.includes(normalizedQuery) || normalizedName.includes(normalizedQuery)) {
      matches.push(relativePath);
    }
  }
}

export async function searchFilesTool(query: string): Promise<string> {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    throw new Error("SearchFiles requires query as a non-empty string.");
  }

  const projectRoot = process.cwd();
  const matches: string[] = [];

  await collectMatchingFiles(projectRoot, projectRoot, normalizedQuery, matches);

  if (matches.length === 0) {
    return `No files matched query: ${query}`;
  }

  return matches.sort().join("\n");
}
