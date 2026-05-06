import { relative } from "node:path";
import { getTypeScriptDocumentSymbols } from "../lsp/lspClient.js";
import { resolveProjectPath } from "./pathSafety.js";

export async function documentSymbolsTool(filePath: string): Promise<string> {
  const absoluteFilePath = await resolveProjectPath(filePath);
  const relativeFilePath = relative(process.cwd(), absoluteFilePath);
  const symbols = await getTypeScriptDocumentSymbols(absoluteFilePath);

  if (symbols.length === 0) {
    return `No document symbols found for ${relativeFilePath}.`;
  }

  const lines = symbols.map((symbol) => {
    const indent = "  ".repeat(symbol.depth);
    return `${indent}- ${symbol.kind}: ${symbol.name} (${symbol.line}:${symbol.column})`;
  });

  return [`Document symbols for ${relativeFilePath}:`, ...lines].join("\n");
}
