export type TypeScriptDiagnostic = {
  filePath: string;
  line: number;
  column: number;
  code: string;
  message: string;
  context?: string;
};

const TYPESCRIPT_ERROR_PATTERN = /^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/;

function isDiagnosticStart(line: string): boolean {
  return TYPESCRIPT_ERROR_PATTERN.test(line);
}

export function parseTypeScriptDiagnostics(output: string): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(TYPESCRIPT_ERROR_PATTERN);

    if (!match) {
      continue;
    }

    const [, filePath, rawLine, rawColumn, code, message] = match;
    const contextLines: string[] = [];

    for (let contextIndex = index + 1; contextIndex < lines.length; contextIndex += 1) {
      const contextLine = lines[contextIndex];

      if (!contextLine.trim()) {
        if (contextLines.length === 0) {
          continue;
        }

        break;
      }

      if (isDiagnosticStart(contextLine) || /^Found \d+ errors?/.test(contextLine)) {
        break;
      }

      contextLines.push(contextLine);
    }

    diagnostics.push({
      filePath,
      line: Number(rawLine),
      column: Number(rawColumn),
      code,
      message,
      context: contextLines.length > 0 ? contextLines.join("\n") : undefined,
    });
  }

  return diagnostics;
}

export function formatTypeScriptDiagnostics(diagnostics: TypeScriptDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No TypeScript diagnostics found.";
  }

  return diagnostics
    .map((diagnostic) => {
      const baseLine = `- ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.code}: ${diagnostic.message}`;

      if (!diagnostic.context) {
        return baseLine;
      }

      return `${baseLine}
  Context:
${diagnostic.context
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}`;
    })
    .join("\n");
}
