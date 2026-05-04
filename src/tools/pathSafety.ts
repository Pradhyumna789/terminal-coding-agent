import { isAbsolute, relative, resolve } from "node:path";

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

export function resolveProjectPath(filePath: string): string {
  const projectRoot = resolve(process.cwd());
  const targetPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(projectRoot, filePath);

  if (!isInsideProjectRoot(projectRoot, targetPath)) {
    throw new PathSafetyError(`Blocked path outside project root: ${filePath}`);
  }

  return targetPath;
}
