import { randomUUID } from "node:crypto";
import { runAgent } from "../agent.js";
import { type SecurityOptions } from "../securityPolicy.js";
import {
  type AgentIdentity,
  type AgentProfile,
  type MultiAgentResult,
  type MultiAgentRunResult,
} from "./types.js";

export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    agentId: "qa-agent",
    agentName: "QA Agent",
    agentRole: "qa",
    displayName: "QA Agent",
    focus: "Find quality risks, edge cases, ambiguity, and user-facing failure modes.",
  },
  {
    agentId: "tester-agent",
    agentName: "Testing Agent",
    agentRole: "test",
    displayName: "Testing Agent",
    focus: "Identify test strategy, manual checks, automated coverage gaps, and verification commands.",
  },
  {
    agentId: "developer-agent",
    agentName: "Developer Agent",
    agentRole: "dev",
    displayName: "Developer Agent",
    focus: "Analyze implementation approach, affected modules, data flow, and integration constraints.",
  },
  {
    agentId: "reviewer-agent",
    agentName: "Review Agent",
    agentRole: "review",
    displayName: "Review Agent",
    focus: "Review maintainability, architecture fit, security concerns, and regression risks.",
  },
];

function createIdentity(orchestrationId: string, profile: AgentProfile): AgentIdentity {
  return {
    orchestrationId,
    agentId: profile.agentId,
    agentName: profile.agentName,
    agentRole: profile.agentRole,
    agentMode: "multi-agent",
  };
}

function buildProfilePrompt(task: string, profile: AgentProfile): string {
  return `You are ${profile.agentName} in a parallel multi-agent analysis run.

Original user task:
${task}

Your role focus:
${profile.focus}

Rules:
- This is read-only parallel mode.
- Do not call Write.
- Do not call Bash.
- Do not modify files.
- Use SearchFiles, Read, TypeCheck, and LSP tools only when helpful.
- Keep your answer concise and specific to your role.
- Do not claim another agent's work as your own.
- Finish with a short role-specific recommendation.`;
}

async function runProfile(
  task: string,
  orchestrationId: string,
  profile: AgentProfile,
  security: SecurityOptions,
): Promise<MultiAgentRunResult> {
  const identity = createIdentity(orchestrationId, profile);
  const readOnlySecurity: SecurityOptions = {
    ...security,
    denyMutatingTools: true,
    allowBash: false,
  };

  try {
    const finalAnswer = await runAgent(buildProfilePrompt(task, profile), {
      mode: "multi-agent",
      identity,
      security: readOnlySecurity,
      promptForRecord: task,
    });

    return {
      profile,
      identity,
      status: "success",
      finalAnswer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      profile,
      identity,
      status: "error",
      finalAnswer: `Error: ${message}`,
    };
  }
}

export async function runMultiAgentOrchestration(
  task: string,
  security: SecurityOptions = {},
  profiles = DEFAULT_AGENT_PROFILES,
): Promise<MultiAgentResult> {
  const orchestrationId = randomUUID();
  const results = await Promise.all(
    profiles.map((profile) => runProfile(task, orchestrationId, profile, security)),
  );

  return {
    orchestrationId,
    results,
  };
}

export function formatMultiAgentResult(result: MultiAgentResult): string {
  const sections = result.results
    .map((runResult) => `${runResult.profile.displayName}:
${runResult.finalAnswer}`)
    .join("\n\n");

  return `Parallel Multi-Agent Result

${sections}

Orchestration ID: ${result.orchestrationId}`;
}
