import { runAgent } from "./agent.js";

function buildDocsPrompt(topic: string): string {
  return `You are in DocuBuddy documentation mode.

Topic:
${topic}

Generate clear Markdown documentation for the requested topic.

Rules:
- Inspect relevant project files using SearchFiles and Read before summarizing architecture.
- Prefer SearchFiles before Read when the exact path is unknown.
- Include Mermaid flowcharts or sequence diagrams when helpful.
- Use valid fenced mermaid code blocks.
- Write the generated Markdown documentation to docs/generated-architecture.md by default.
- If docs/ does not exist, create it first using Bash.
- Use Write to create or overwrite docs/generated-architecture.md.
- Keep the final terminal answer short. Mention the file path, inspected files, and whether the file was written.
- Do not claim to have inspected files that you did not inspect.
- Do not print the full generated documentation in the final answer after writing the file.`;
}

export async function runDocsMode(topic: string): Promise<string> {
  return runAgent(buildDocsPrompt(topic), {
    mode: "docs",
  });
}
