export type TypeScriptDiagnostic = {
  filePath: string;
  line: number;
  column: number;
  message: string;
};

const TYPESCRIPT_ERROR_PATTERN = /^(.+?):(\d+):(\d+) - error TS\d+: (.+)$/gm;

export function parseTypeScriptDiagnostics(output: string): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];

  for (const match of output.matchAll(TYPESCRIPT_ERROR_PATTERN)) {
    const [, filePath, line, column, message] = match;

    diagnostics.push({
      filePath,
      line: Number(line),
      column: Number(column),
      message,
    });
  }

  return diagnostics;
}

export function formatTypeScriptDiagnostics(diagnostics: TypeScriptDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No TypeScript diagnostics found.";
  }

  return diagnostics
    .map(
      (diagnostic) =>
        `- ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} - Type error: ${diagnostic.message}`,
    )
    .join("\n");
}
