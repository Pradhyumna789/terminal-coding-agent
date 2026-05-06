import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

const DEFAULT_MAX_RESULTS = 25;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "runs",
  ".vscode",
  ".idea",
]);
const IGNORED_FILE_NAMES = new Set([
  ".env",
  "notes.txt",
  "interactive-notes.txt",
  "generated-architecture.md",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".exe",
  ".dll",
  ".node",
  ".pdb",
  ".woff",
  ".woff2",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export type SearchFilesOptions = {
  searchText?: boolean;
  maxResults?: number;
};

type SearchMatch = {
  relativePath: string;
  matchType: "file" | "text";
  score: number;
  lineNumber?: number;
  snippet?: string;
};

function isIgnoredFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  const extension = extname(lowerName);

  return (
    IGNORED_FILE_NAMES.has(lowerName) ||
    lowerName.endsWith(".log") ||
    lowerName.startsWith(".env.") ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    BINARY_EXTENSIONS.has(extension) ||
    (lowerName.startsWith("sample") && lowerName.endsWith(".txt"))
  );
}

function toRelativePath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split(sep).join("/");
}

function rankFileMatch(relativePath: string, normalizedQuery: string): number {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedName = basename(relativePath).toLowerCase();

  if (normalizedName === normalizedQuery) {
    return 100;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 80;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 60;
  }

  if (normalizedPath.includes(normalizedQuery)) {
    return 40;
  }

  return 0;
}

function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) {
    return DEFAULT_MAX_RESULTS;
  }

  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error("SearchFiles max_results must be a positive integer.");
  }

  return Math.min(maxResults, 100);
}

async function collectProjectFiles(
  directory: string,
  projectRoot: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectProjectFiles(fullPath, projectRoot, files);
      }

      continue;
    }

    if (entry.isFile() && !isIgnoredFile(entry.name)) {
      files.push(toRelativePath(projectRoot, fullPath));
    }
  }
}

async function collectTextMatches(
  projectRoot: string,
  relativePath: string,
  normalizedQuery: string,
): Promise<SearchMatch[]> {
  const fullPath = join(projectRoot, relativePath);
  let content: string;

  try {
    content = await readFile(fullPath, "utf-8");
  } catch {
    return [];
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_TEXT_FILE_BYTES) {
    return [];
  }

  const matches: SearchMatch[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const normalizedLine = line.toLowerCase();
    const column = normalizedLine.indexOf(normalizedQuery);

    if (column !== -1) {
      matches.push({
        relativePath,
        matchType: "text",
        score: 50,
        lineNumber: index + 1,
        snippet: line.trim().slice(0, 160),
      });
    }

    if (matches.length >= 3) {
      break;
    }
  }

  return matches;
}

function formatMatches(matches: SearchMatch[]): string {
  if (matches.length === 0) {
    return "";
  }

  return matches
    .map((match) => {
      if (match.matchType === "text") {
        return `${match.relativePath}:${match.lineNumber} [text] ${match.snippet ?? ""}`;
      }

      return `${match.relativePath} [file]`;
    })
    .join("\n");
}

export async function searchFilesTool(
  query: string,
  options: SearchFilesOptions = {},
): Promise<string> {
  const normalizedQuery = query.trim().toLowerCase();
  const maxResults = normalizeMaxResults(options.maxResults);

  if (!normalizedQuery) {
    throw new Error("SearchFiles requires query as a non-empty string.");
  }

  const projectRoot = process.cwd();
  const files: string[] = [];

  await collectProjectFiles(projectRoot, projectRoot, files);

  const matches: SearchMatch[] = files
    .map((relativePath) => ({
      relativePath,
      matchType: "file" as const,
      score: rankFileMatch(relativePath, normalizedQuery),
    }))
    .filter((match) => match.score > 0);

  if (options.searchText) {
    for (const relativePath of files) {
      matches.push(...(await collectTextMatches(projectRoot, relativePath, normalizedQuery)));
    }
  }

  const rankedMatches = matches
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
    .slice(0, maxResults);
  const formatted = formatMatches(rankedMatches);

  if (!formatted) {
    return `No files matched query: ${query}`;
  }

  return formatted;
}
