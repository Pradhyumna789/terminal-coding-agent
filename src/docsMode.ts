import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import { type SecurityOptions } from "./securityPolicy.js";
import { createWorkflowRecorder, runWorkflowPhase } from "./workflow.js";

export const GENERATED_DOCS_PATH = "docs/generated-architecture.md";

export function buildDocsPrompt(topic: string): string {
  return `You are in DocuBuddy documentation mode.

Topic:
${topic}

Generate complete Markdown documentation for the requested topic.

Rules:
- Inspect relevant project files using SearchFiles and Read before summarizing architecture.
- Prefer SearchFiles before Read when the exact path is unknown.
- Include at least one valid fenced mermaid code block.
- Do not call Write.
- Do not create files.
- Return only the Markdown document content.
- Do not claim to have inspected files that you did not inspect.`;
}

export function ensureMermaidDiagram(markdown: string, topic: string): string {
  if (markdown.includes("```mermaid")) {
    return markdown;
  }

  return `${markdown.trim()}

## Generated Workflow Diagram

\`\`\`mermaid
flowchart TD
  Request["Documentation request"] --> Inspect["Inspect relevant files"]
  Inspect --> Generate["Generate Markdown for ${topic.replaceAll('"', "'")}"]
  Generate --> Save["Save generated documentation"]
\`\`\`
`;
}

export async function writeGeneratedDocs(markdown: string): Promise<string> {
  const docsDirectory = join(process.cwd(), "docs");
  const outputPath = join(process.cwd(), GENERATED_DOCS_PATH);

  await mkdir(docsDirectory, { recursive: true });
  await writeFile(outputPath, markdown, "utf-8");

  return outputPath;
}

export async function verifyGeneratedDocs(): Promise<string> {
  const outputPath = join(process.cwd(), GENERATED_DOCS_PATH);
  const content = await readFile(outputPath, "utf-8");

  if (!content.trim().startsWith("#") && !content.includes("\n#")) {
    throw new Error("Generated documentation does not appear to contain Markdown headings.");
  }

  if (!content.includes("```mermaid")) {
    throw new Error("Generated documentation does not contain a Mermaid diagram.");
  }

  return `Verified ${GENERATED_DOCS_PATH} with ${content.length} characters.`;
}

export async function runDocsMode(topic: string, security?: SecurityOptions): Promise<string> {
  const workflow = createWorkflowRecorder();

  workflow.recordPhaseStarted("docs-generation");
  workflow.recordPhaseCompleted("docs-generation", "LLM documentation generation requested.");
  const markdown = await runAgent(buildDocsPrompt(topic), {
    mode: "docs",
    security,
    promptForRecord: topic,
    workflowEvents: workflow.events,
  });
  const finalMarkdown = ensureMermaidDiagram(markdown, topic);

  await runWorkflowPhase(
    workflow,
    "docs-write",
    () => writeGeneratedDocs(finalMarkdown),
    () => `Wrote ${GENERATED_DOCS_PATH}.`,
  );

  const verificationSummary = await runWorkflowPhase(
    workflow,
    "docs-verification",
    verifyGeneratedDocs,
    (summary) => summary,
  );
  workflow.recordVerificationResult("docs-file", true, verificationSummary);

  return `Documentation generated successfully.
File: ${GENERATED_DOCS_PATH}
${verificationSummary}`;
}
