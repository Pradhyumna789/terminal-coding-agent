import { getTypeScriptReferences } from "../lsp/lspClient.js";
import { resolveProjectPath } from "./pathSafety.js";

function formatLocations(locations: Awaited<ReturnType<typeof getTypeScriptReferences>>): string {
  if (locations.length === 0) {
    return "No references found.";
  }

  return locations
    .map((location) => `- ${location.filePath}:${location.line}:${location.column}`)
    .join("\n");
}

export async function findReferencesTool(
  filePath: string,
  line: number,
  column: number,
): Promise<string> {
  const absoluteFilePath = await resolveProjectPath(filePath);
  const locations = await getTypeScriptReferences(absoluteFilePath, line, column);

  return `References for ${filePath}:${line}:${column}
${formatLocations(locations)}`;
}
