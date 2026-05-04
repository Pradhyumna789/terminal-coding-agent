import { type ChatMessage, sendMessagesToLlm } from "./llmClient.js";

function buildSpecPrompt(task: string): string {
  return `Create a short implementation specification for this task.

Task:
${task}

Do not modify files.
Do not call tools.
Do not include hidden reasoning.

Use this exact format:
1. Requirement summary
2. Assumptions
3. Edge cases
4. Files likely affected
5. Test plan
6. Confirmation question`;
}

export async function runSpecFirst(task: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: buildSpecPrompt(task),
    },
  ];

  const assistantMessage = await sendMessagesToLlm(messages, { includeTools: false });
  const content = assistantMessage.content?.trim();

  if (!content) {
    throw new Error(
      "The model returned an empty spec-first response. Try a shorter task or a different model.",
    );
  }

  return content;
}
