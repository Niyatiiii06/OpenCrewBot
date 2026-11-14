// Types shared by the server and the browser. Everything here is plain JSON.

/** Ask first: every sensitive action waits for you. Controlled: pre-approved
 * actions run within limits, the rest ask. Full: permitted actions run on their own. */
export type ApprovalMode = "ask" | "controlled" | "full";

/** What a bot may do with one tool: run it, ask first, or never. */
export type ToolPolicy = "allow" | "ask" | "deny";

/** Limits that apply in Controlled access. */
export interface BotLimits {
  /** Most sensitive actions one turn may run without asking. */
  maxActionsPerRun: number;
  /** Email may go only to these domains without asking (empty = always ask). */
  allowedEmailDomains: string[];
  /** GitHub writes may target only these owner/repo names without asking (empty = always ask). */
  allowedRepos: string[];
}

export interface BotTools {
  /** Tavily search, extract and crawl. */
  webSearch: boolean;
  /** Read and update the bot's MEMORY.md. */
  memory: boolean;
  /** Let the model write one TypeScript function that calls several tools at once. */
  codeMode: boolean;
  /** A real browser (Playwright) the bot can drive. */
  browser: boolean;
  /** The bot may stop and ask you a question with a card in chat. */
  askUser: boolean;
  /** Delegate to, ask, and verify with teammates; share findings in a room. */
  collaboration?: boolean;
  /** Read spreadsheets, calculate, and draw charts. */
  dataAnalysis?: boolean;
  /** Inspect GitHub repositories; open issues (asks first). */
  github?: boolean;
  /** Send email through Gmail (asks first). */
  email?: boolean;
  /** Post to Slack (asks first). */
  slack?: boolean;
  /** Create Notion pages (asks first). */
  notion?: boolean;
  /** Save reports and other deliverables as files. */
  artifacts?: boolean;
}

/** `chief` plans and delegates; `member` does the work it is given. */
export type BotRole = "chief" | "member";

export interface Bot {
  id: string;
  name: string;
  /** Lowercase handle used for @mentions in rooms. */
  handle: string;
  title: string;
  description: string;
  instructions: string;
  emoji: string;
  color: string;
  model: string;
  tools: BotTools;
  /** Connection ids this bot may use: `composio:<toolkit>` or `mcp:<serverId>`. */
  connections: string[];
  approval: ApprovalMode;
  pinned: boolean;
  createdAt: string;
  role: BotRole;
  /** Skill ids this bot always carries. Other skills load when a task calls for them. */
  skills: string[];
  /** How this bot should shape its answers, e.g. "Markdown report with a summary table". */
  outputFormat: string;
  /** `fixed` uses `model`; `auto` picks a model per task (fast, balanced or strong). */
  modelMode: "fixed" | "auto";
  /** Tried in order when the main model fails. */
  fallbackModels: string[];
  /** Per-tool overrides of the approval level. */
  toolPolicy: Record<string, ToolPolicy>;
  limits: BotLimits;
  /** Who made this bot: the first-run seed, you, the agent factory, or the Chief of Staff. */
  createdBy: "seed" | "user" | "factory" | "chief";
}

type BotOptional = "role" | "skills" | "outputFormat" | "modelMode" | "fallbackModels" | "toolPolicy" | "limits" | "createdBy";

export type BotInput = Omit<Bot, "id" | "createdAt" | "handle" | "connections" | BotOptional> & {
  handle?: string;
  connections?: string[];
} & Partial<Pick<Bot, BotOptional>>;

/** `chief`: the Chief of Staff turns each request into a task plan and delegates it. */
export type RoomResponder = "auto" | "lead" | "everyone" | "chief";

export interface Room {
  id: string;
  name: string;
  topic: string;
  emoji: string;
  memberIds: string[];
  leadId: string | null;
  responder: RoomResponder;
  pinned: boolean;
  createdAt: string;
}

export type RoomInput = Omit<Room, "id" | "createdAt">;

/** `dm:<botId>` or `room:<roomId>`. */
export type ConversationId = string;

export interface Source {
  title: string;
  url: string;
}

export type ToolStatus = "running" | "awaiting-approval" | "done" | "error" | "denied";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      name: string;
      label: string;
      detail?: string;
      status: ToolStatus;
      preview?: string;
      sources?: Source[];
    }
  | {
      kind: "question";
      toolCallId: string;
      question: string;
      options: { label: string; description?: string }[];
      answer?: string;
    }
  /** A live task plan. The card reads the plan by id and updates as tasks move. */
  | { kind: "plan"; planId: string }
  /** A saved deliverable (report, chart, calendar) the person can open. */
  | { kind: "artifact"; artifactId: string; title: string; path: string };

export type MessageStatus = "streaming" | "done" | "error" | "stopped";

export interface RouteNote {
  by: "mention" | "jev" | "lead" | "everyone" | "handoff" | "chief" | "task" | "teammate" | "workflow";
  confidence?: number;
  /** For task turns: which plan and task this reply belongs to. */
  planId?: string;
  taskId?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: ConversationId;
  role: "user" | "bot" | "notice";
  botId?: string;
  createdAt: string;
  status: MessageStatus;
  parts: Part[];
  model?: string;
  usage?: { input: number; output: number; costUsd: number | null };
  route?: RouteNote;
  error?: string;
  /** True when the reply came from the scripted mock model, not a real one. */
  simulated?: boolean;
  /** Set when the main model failed and another one answered. */
  fallbackFrom?: string;
}

export interface ConversationSummary {
  id: ConversationId;
  lastMessage?: { text: string; createdAt: string; author: string };
  running: string[];
  unread: number;
}

export interface ModelOption {
  /** `<provider>/<model>`, e.g. `groq/openai/gpt-oss-120b`. */
  id: string;
  label: string;
  provider: string;
  providerName?: string;
  /** False when the provider has no key configured. */
  available?: boolean;
  context: number;
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  inputPerM: number | null;
  outputPerM: number | null;
  live: boolean;
}

export interface AppStatus {
  /** True when no model provider is configured: bots run on the scripted mock model. */
  mock: boolean;
  keys: { nebius: boolean; tavily: boolean; jev: boolean; browserbase: boolean; composio: boolean };
  dataDir: string;
  /** Model providers with a key (or a local server address) set. */
  providers?: string[];
  defaultModel?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  envVar: string;
  keysUrl: string;
  free: boolean;
  local: boolean;
  configured: boolean;
  models: string[];
}

/** Events the server pushes to the browser over one SSE stream. */
export type ServerEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; conversationId: ConversationId; messageId: string; partIndex: number; kind: "text" | "reasoning"; delta: string }
  | { type: "running"; conversationId: ConversationId; botIds: string[] }
  | { type: "bots-changed" }
  | { type: "rooms-changed" }
  | { type: "memory-changed"; botId: string }
  /** A bot's Browserbase live view opened (url) or closed (null). */
  | { type: "browser-session"; botId: string; liveUrl: string | null }
  | { type: "connections-changed" }
  | { type: "plan"; plan: Plan }
  | { type: "approvals-changed" }
  | { type: "memory-scope-changed"; scope: string }
  | { type: "workflows-changed" }
  | { type: "skills-changed" }
  | { type: "integrations-changed" };

/** An app from Composio's catalog, with this install's connection state. */
export interface ComposioApp {
  slug: string;
  name: string;
  logo?: string;
  connected: boolean;
}

/** A remote MCP server you added. The token never leaves the server. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  headerNames: string[];
}

export interface ConnectionsState {
  composio: { enabled: boolean; apps: ComposioApp[]; error?: string };
  mcpServers: McpServer[];
}

/** Something a bot can be given access to. */
export interface ConnectionOption {
  id: string;
  name: string;
  kind: "composio" | "mcp";
  logo?: string;
}

// ── OpenCrewBot 2.0: workforce types ────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped"
  | "timed-out"
  | "interrupted";

export type TaskKind = "work" | "review" | "consolidate";

export interface TaskAttempt {
  n: number;
  startedAt: string;
  finishedAt?: string;
  model?: string;
  status: "running" | "done" | "failed" | "timed-out" | "cancelled" | "interrupted";
  error?: string;
}

export interface Task {
  id: string;
  planId: string;
  /** Short label shown on the board, e.g. "T3". */
  ref: string;
  title: string;
  /** The full brief the assigned agent receives. */
  description: string;
  kind: TaskKind;
  agentId: string;
  /** Agent first assigned, kept when the engine reassigns after failures. */
  originalAgentId?: string;
  dependsOn: string[];
  /** Skill ids loaded for this task. */
  skills: string[];
  /** What the task needs, in the planner's words (e.g. "web research"). */
  capability: string;
  status: TaskStatus;
  /** True when the task is expected to take an action that needs your approval. */
  needsApproval: boolean;
  /** Set while the task is parked on an approval request. */
  approvalId?: string;
  attempts: TaskAttempt[];
  maxAttempts: number;
  timeoutMs: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  output?: string;
  error?: string;
  /** Message in the room that holds this task's reply. */
  messageId?: string;
  /** Who created the task: the plan, a replan, or a teammate's delegation. */
  origin: "plan" | "replan" | "delegation" | "review";
  /** For delegated tasks: the task that asked for it, and how deep the chain is. */
  parentTaskId?: string;
  depth: number;
  usage?: { input: number; output: number; costUsd: number | null };
  model?: string;
}

export type PlanStatus = "planning" | "running" | "awaiting-approval" | "done" | "failed" | "cancelled" | "interrupted";

export interface PlanEvent {
  at: string;
  kind: string;
  text: string;
  taskId?: string;
}

export interface Plan {
  id: string;
  conversationId: ConversationId;
  /** The person's instruction, as given. */
  instruction: string;
  /** Later instructions that changed the plan while it ran. */
  amendments: { at: string; text: string }[];
  /** One-line restatement of the goal, written by the Chief of Staff. */
  goal: string;
  chiefId: string;
  status: PlanStatus;
  tasks: Task[];
  events: PlanEvent[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The consolidated deliverable. */
  result?: string;
  artifactId?: string;
  /** How the plan was made: by a model, or by the built-in rule planner (mock mode / fallback). */
  plannedBy: "model" | "rules";
  model?: string;
  simulated: boolean;
  workflowId?: string;
  /** Counters for the collaboration guards. */
  budget: { delegations: number; teammateMessages: number; maxDelegations: number; maxTeammateMessages: number; maxTasks: number };
  usage: { input: number; output: number; costUsd: number };
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface Approval {
  id: string;
  conversationId: ConversationId;
  botId: string;
  toolCallId: string;
  tool: string;
  /** What will happen, in plain words. */
  title: string;
  /** The exact content of the action: recipient and body of an email, issue text, URL… */
  preview: string;
  args: unknown;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: "you" | "system";
  note?: string;
  planId?: string;
  taskId?: string;
  /** Filled when the action actually ran after approval. */
  executedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  botId?: string;
  botName?: string;
  tool?: string;
  /** e.g. "approval-requested", "approved", "rejected", "executed", "blocked", "auto-allowed". */
  event: string;
  detail: string;
  conversationId?: string;
  approvalId?: string;
  planId?: string;
  taskId?: string;
  /** True for actions that were recorded but not sent to a real service. */
  simulated?: boolean;
}

export type MemoryScopeKind = "agent" | "room" | "project" | "user" | "decisions" | "history";

export interface MemoryScope {
  /** `agent:<botId>`, `room:<roomId>`, `project`, `user`, `decisions` or `history`. */
  id: string;
  kind: MemoryScopeKind;
  title: string;
  description: string;
  path: string;
  bytes: number;
  updatedAt: string | null;
}

export interface MemoryLogEntry {
  id: string;
  at: string;
  scope: string;
  action: "add" | "edit" | "user-edit" | "system";
  /** What was remembered. */
  text: string;
  /** Who wrote it: a bot name, "You" or "System". */
  by: string;
  /** Why it was saved. */
  why: string;
  /** Where it came from: a conversation, a task, or the memory editor. */
  source: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Words that suggest this skill fits a task. */
  triggers: string[];
  /** Tools the skill expects the agent to use. */
  tools: string[];
  /** Shape of the expected output. */
  output: string;
  /** The full instructions (Markdown). */
  body: string;
  /** Built-in skills ship in `skills/`; your own live in the data folder. */
  source: "built-in" | "custom";
  path: string;
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  group: string;
  /** Whether it reads, changes local data, or acts outside the app. */
  risk: "read" | "local" | "external";
  /** Live when it can reach a real service right now; otherwise why not. */
  live: boolean;
  note?: string;
}

export type IntegrationState = "live" | "not-configured" | "error";

export interface IntegrationInfo {
  id: string;
  name: string;
  description: string;
  state: IntegrationState;
  /** What works right now, in one line. */
  detail: string;
  /** Fields the person can fill in the Integration manager (stored encrypted, never returned). */
  fields: { key: string; label: string; secret: boolean; set: boolean; hint?: string }[];
  /** Tools this integration provides. */
  tools: string[];
  docsUrl?: string;
  lastTest?: { at: string; ok: boolean; message: string };
}

export type WorkflowSchedule =
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; day: number; time: string }
  | { type: "manual" };

export interface Workflow {
  id: string;
  name: string;
  instruction: string;
  /** Room the workflow runs in. */
  conversationId: ConversationId;
  schedule: WorkflowSchedule;
  status: "active" | "paused";
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: "done" | "failed" | "cancelled" | "running";
  failures: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed" | "cancelled";
  planId?: string;
  artifactId?: string;
  summary?: string;
  error?: string;
}

export interface Artifact {
  id: string;
  title: string;
  /** File name inside the artifacts folder. */
  file: string;
  kind: "report" | "chart" | "data" | "draft";
  createdAt: string;
  botId?: string;
  planId?: string;
  taskId?: string;
  conversationId?: string;
  bytes: number;
  simulated?: boolean;
}

export interface UsageRow {
  key: string;
  calls: number;
  input: number;
  output: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageRow;
  byModel: UsageRow[];
  byBot: UsageRow[];
  byDay: UsageRow[];
}

/** What the agent factory proposes from a plain-language description. */
export interface AgentDraft {
  input: BotInput;
  /** Why these choices were made, for the preview. */
  rationale: string;
  /** First lines for the new bot's MEMORY.md. */
  memorySeed: string;
  draftedBy: "model" | "rules";
}
