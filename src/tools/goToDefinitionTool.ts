import { getTypeScriptDefinition } from "../lsp/lspClient.js";
import { resolveProjectPath } from "./pathSafety.js";

function formatLocations(locations: Awaited<ReturnType<typeof getTypeScriptDefinition>>): string {
  if (locations.length === 0) {
    return "No definition found.";
  }

  return locations
    .map((location) => `- ${location.filePath}:${location.line}:${location.column}`)
    .join("\n");
}

export async function goToDefinitionTool(
  filePath: string,
  line: number,
  column: number,
): Promise<string> {
  const absoluteFilePath = await resolveProjectPath(filePath);
  const locations = await getTypeScriptDefinition(absoluteFilePath, line, column);

  return `Definitions for ${filePath}:${line}:${column}
${formatLocations(locations)}`;
}
