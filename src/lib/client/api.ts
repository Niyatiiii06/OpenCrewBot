import type {
  AppStatus,
  Bot,
  BotInput,
  ChatMessage,
  ComposioApp,
  ConnectionsState,
  ConversationId,
  ConversationSummary,
  AgentDraft,
  Approval,
  Artifact,
  AuditEntry,
  IntegrationInfo,
  McpServer,
  MemoryLogEntry,
  MemoryScope,
  ModelOption,
  Plan,
  ProviderInfo,
  Skill,
  ToolInfo,
  UsageSummary,
  Workflow,
  WorkflowRun,
  Room,
  RoomInput,
} from "@/lib/shared/types";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const conv = (id: ConversationId) => `/api/conversations/${encodeURIComponent(id)}`;

export interface Bootstrap {
  status: AppStatus;
  bots: Bot[];
  rooms: Room[];
  conversations: ConversationSummary[];
  models: ModelOption[];
  /** botId → Browserbase live view URL for bots with an open browser. */
  liveViews: Record<string, string>;
  plans?: Plan[];
  pendingApprovals?: number;
}

export type WorkflowRow = Workflow & { scheduleText: string };
export type ArtifactRow = Artifact & { url: string };

export const api = {
  bootstrap: () => call<Bootstrap>("/api/bootstrap"),
  models: (refresh = false) => call<{ models: ModelOption[] }>(`/api/models${refresh ? "?refresh=1" : ""}`),
  createBot: (input: BotInput) => call<{ bot: Bot }>("/api/bots", { method: "POST", json: input }),
  updateBot: (id: string, patch: Partial<BotInput>) => call<{ bot: Bot }>(`/api/bots/${id}`, { method: "PATCH", json: patch }),
  deleteBot: (id: string) => call(`/api/bots/${id}`, { method: "DELETE" }),
  getMemory: (id: string) => call<{ content: string; path: string; limit: { lines: number; bytes: number } }>(`/api/bots/${id}/memory`),
  saveMemory: (id: string, content: string) => call<{ content: string }>(`/api/bots/${id}/memory`, { method: "PUT", json: { content } }),
  createRoom: (input: RoomInput) => call<{ room: Room }>("/api/rooms", { method: "POST", json: input }),
  updateRoom: (id: string, patch: Partial<RoomInput>) => call<{ room: Room }>(`/api/rooms/${id}`, { method: "PATCH", json: patch }),
  deleteRoom: (id: string) => call(`/api/rooms/${id}`, { method: "DELETE" }),
  messages: (id: ConversationId) => call<{ messages: ChatMessage[]; running: string[] }>(`${conv(id)}/messages`),
  send: (id: ConversationId, text: string) => call<{ message: ChatMessage }>(`${conv(id)}/messages`, { method: "POST", json: { text } }),
  approve: (id: ConversationId, botId: string, toolCallId: string, approve: boolean) =>
    call(`${conv(id)}/approval`, { method: "POST", json: { botId, toolCallId, approve } }),
  answer: (id: ConversationId, botId: string, toolCallId: string, answer: string) =>
    call(`${conv(id)}/answer`, { method: "POST", json: { botId, toolCallId, answer } }),
  stop: (id: ConversationId) => call(`${conv(id)}/stop`, { method: "POST" }),
  clear: (id: ConversationId) => call(`${conv(id)}/clear`, { method: "POST" }),
  read: (id: ConversationId) => call(`${conv(id)}/read`, { method: "POST" }),
  connections: () => call<ConnectionsState>("/api/connections"),
  searchApps: (q: string) => call<{ apps: ComposioApp[] }>(`/api/connections/composio/search?q=${encodeURIComponent(q)}`),
  connectApp: (slug: string) => call<{ redirectUrl: string }>("/api/connections/composio/connect", { method: "POST", json: { slug } }),
  disconnectApp: (slug: string) => call("/api/connections/composio/disconnect", { method: "POST", json: { slug } }),
  connectionsChanged: () => call("/api/connections/changed", { method: "POST" }),
  addMcpServer: (input: { name: string; url: string; token?: string; headers?: Record<string, string> }) =>
    call<{ server: McpServer }>("/api/connections/mcp", { method: "POST", json: input }),
  removeMcpServer: (id: string) => call(`/api/connections/mcp/${id}`, { method: "DELETE" }),
  // OpenCrewBot 2.0
  plans: () => call<{ plans: Plan[] }>("/api/plans"),
  planAction: (id: string, action: "cancel" | "resume" | "cancel-task" | "retry-task", taskId?: string) =>
    call<{ plan: Plan | null }>(`/api/plans/${id}`, { method: "POST", json: { action, taskId } }),
  approvals: () => call<{ approvals: Approval[]; audit: AuditEntry[] }>("/api/approvals"),
  decide: (id: string, approve: boolean) => call(`/api/approvals/${id}`, { method: "POST", json: { approve } }),
  memoryScopes: () => call<{ scopes: MemoryScope[]; log: MemoryLogEntry[] }>("/api/memory"),
  memoryScope: (scope: string) => call<{ content: string; path: string; log: MemoryLogEntry[] }>(`/api/memory/${encodeURIComponent(scope)}`),
  saveMemoryScope: (scope: string, content: string, why?: string) =>
    call<{ content: string }>(`/api/memory/${encodeURIComponent(scope)}`, { method: "PUT", json: { content, why } }),
  skills: () => call<{ skills: Skill[]; tools: ToolInfo[] }>("/api/skills"),
  saveSkill: (input: { id?: string; name: string; description: string; triggers: string[]; tools: string[]; output: string; body: string }) =>
    call<{ skill: Skill }>("/api/skills", { method: "POST", json: input }),
  deleteSkill: (id: string) => call(`/api/skills/${id}`, { method: "DELETE" }),
  integrations: () => call<{ integrations: IntegrationInfo[] }>("/api/integrations"),
  saveIntegration: (id: string, values: Record<string, string>, preset?: string) =>
    call<{ integrations: IntegrationInfo[] }>("/api/integrations", { method: "POST", json: { id, values, preset } }),
  testIntegration: (id: string) => call<{ ok: boolean; message: string }>(`/api/integrations/${id}/test`, { method: "POST" }),
  providers: () =>
    call<{ providers: ProviderInfo[]; usage: UsageSummary; models: ModelOption[]; routing: Record<"fast" | "balanced" | "strong", string | null> }>("/api/providers"),
  workflows: () => call<{ workflows: WorkflowRow[]; runs: WorkflowRun[] }>("/api/workflows"),
  createWorkflow: (input: { name: string; instruction: string; conversationId: string; schedule: string }) =>
    call<{ workflow: Workflow }>("/api/workflows", { method: "POST", json: input }),
  updateWorkflow: (id: string, patch: { status?: "active" | "paused"; schedule?: string; name?: string; instruction?: string }) =>
    call<{ workflow: Workflow }>(`/api/workflows/${id}`, { method: "PATCH", json: patch }),
  runWorkflow: (id: string) => call<{ run: WorkflowRun }>(`/api/workflows/${id}`, { method: "POST" }),
  deleteWorkflow: (id: string) => call(`/api/workflows/${id}`, { method: "DELETE" }),
  draftAgent: (description: string) => call<{ draft: AgentDraft }>("/api/factory", { method: "POST", json: { description } }),
  createFromDraft: (input: BotInput, memorySeed: string) => call<{ bot: Bot }>("/api/factory", { method: "POST", json: { input, memorySeed } }),
  artifacts: () => call<{ artifacts: ArtifactRow[] }>("/api/artifacts"),
  dataFiles: () => call<{ files: { name: string; where: string }[] }>("/api/uploads"),
  upload: (name: string, content: string) => call<{ files: { name: string; where: string }[] }>("/api/uploads", { method: "POST", json: { name, content } }),
  testMcpServer: (id: string) => call<{ tools: number }>(`/api/connections/mcp/${id}/test`, { method: "POST" }),
};
