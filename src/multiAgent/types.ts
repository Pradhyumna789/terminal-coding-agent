export type AgentIdentity = {
  orchestrationId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentMode: "multi-agent";
};

export type AgentProfile = {
  agentId: string;
  agentName: string;
  agentRole: string;
  displayName: string;
  focus: string;
};

export type MultiAgentRunResult = {
  profile: AgentProfile;
  identity: AgentIdentity;
  status: "success" | "error";
  finalAnswer: string;
};

export type MultiAgentResult = {
  orchestrationId: string;
  results: MultiAgentRunResult[];
};
