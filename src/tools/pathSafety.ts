import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

function isInsideProjectRoot(projectRoot: string, targetPath: string): boolean {
  const relativePath = relative(projectRoot, targetPath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function getRealProjectRoot(): Promise<string> {
  return realpath(resolve(process.cwd()));
}

function resolveRequestedPath(projectRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
}

export async function resolveProjectPath(filePath: string): Promise<string> {
  const projectRoot = await getRealProjectRoot();
  const requestedPath = resolveRequestedPath(projectRoot, filePath);

  if (!isInsideProjectRoot(projectRoot, requestedPath)) {
    throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
  }

  const targetPath = await realpath(requestedPath);

  if (!isInsideProjectRoot(projectRoot, targetPath)) {
    throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
  }

  return targetPath;
}

export async function resolveWritableProjectPath(filePath: string): Promise<string> {
  const projectRoot = await getRealProjectRoot();
  const targetPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(projectRoot, filePath);

  if (!isInsideProjectRoot(projectRoot, targetPath)) {
    throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
  }

  let existingAncestor = dirname(targetPath);

  while (existingAncestor !== dirname(existingAncestor)) {
    try {
      const realAncestor = await realpath(existingAncestor);

      if (!isInsideProjectRoot(projectRoot, realAncestor)) {
        throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
      }

      break;
    } catch (error) {
      if (error instanceof PathSafetyError) {
        throw error;
      }

      existingAncestor = dirname(existingAncestor);
    }
  }

  try {
    const existingTargetPath = await realpath(targetPath);

    if (!isInsideProjectRoot(projectRoot, existingTargetPath)) {
      throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
    }
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw error;
    }
  }

  return targetPath;
}
