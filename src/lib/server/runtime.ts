// The agent harness glue. Mastra's AgentController owns the agent loop,
// sessions, thread history, tool approvals and ask-user suspensions. This file
// gives each bot one controller, each conversation one session, and folds the
// controller's events into the chat messages the UI renders.
//
// OpenCrewBot 2.0 changes here:
// - Models come from any provider, chosen per turn, with a fallback chain when
//   a provider fails (the original was fixed to `nebius/<model>`).
// - Each turn registers a context (conversation, plan, task) that tools read.
// - Approval requests and tool executions are written to the approval centre
//   and the audit log; token use is written to the usage log.
// - A single bot's turn can be stopped without stopping the whole conversation,
//   which the execution engine needs for timeouts and cancellation.
import { Agent } from "@mastra/core/agent";
import { AgentController, type AgentControllerEvent, type Session } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { RequestContext } from "@mastra/core/request-context";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { randomUUID } from "node:crypto";
import type { Bot, ChatMessage, ConversationId, Part, RouteNote } from "@/lib/shared/types";
import { MASTRA_DB_URL, OWNER_ID, isMock } from "./config";
import { addUsage, conversationGeneration, getBot, getRoom, saveMessage } from "./db";
import { publish } from "./bus";
import { costOf, findModel } from "./models";
import { createMockModel } from "./mock-model";
import { announceLiveView, createSession, releaseSession } from "./browserbase";
import { buildConnectorTools, connectionsVersion } from "./connectors";
import { systemPrompt } from "./prompt";
import { buildTools, toolCategory, toolLabel, toolPreview, toolSources } from "./tools";
import { TOOL_META, audit, pendingFor, recordApproval, releaseGate, settleApproval } from "./permissions";
import { markModelFailed, modelChain, modelForTier, routerConfig, type RoutingTier } from "./providers";
import { clearTurn, setTurn, type TurnContext } from "./turns";

// ── shared state that must survive Next.js hot reloads ─────────────────

interface BotRuntime {
  signature: string;
  /** The latest saved bot; the system prompt reads it on every model call. */
  holder: { bot: Bot };
  controller: AgentController;
  ready: Promise<void>;
  /** Disconnects the bot's MCP servers. */
  closeConnectors: () => Promise<void>;
}

interface State {
  storage: LibSQLStore;
  runtimes: Map<string, BotRuntime>;
  /** `${conversationId}|${botId}` → live session */
  sessions: Map<string, Session>;
  /** `${conversationId}|${botId}` → tail of that bot's turn queue */
  chains: Map<string, Promise<unknown>>;
  /** conversationId → bots with a turn in flight */
  running: Map<ConversationId, Set<string>>;
  /** `${conversationId}|${botId}` → the turn currently folding events */
  folders: Map<string, TurnFolder>;
  /** conversationId → bumped by Stop, so turns queued before it never start */
  stopEpoch: Map<ConversationId, number>;
  /** `${conversationId}|${botId}` → aborts that one turn (stop, cancel, timeout) */
  aborts: Map<string, AbortController>;
}

const g = globalThis as unknown as { __opencrewbotRuntime?: State };
const state: State = (g.__opencrewbotRuntime ??= {
  storage: new LibSQLStore({ id: "opencrewbot-mastra", url: MASTRA_DB_URL }),
  runtimes: new Map(),
  sessions: new Map(),
  chains: new Map(),
  running: new Map(),
  folders: new Map(),
  stopEpoch: new Map(),
  aborts: new Map(),
});
state.aborts ??= new Map();

const key = (conversationId: ConversationId, botId: string) => `${conversationId}|${botId}`;

// ── one controller per bot ──────────────────────────────────────────────

/** Settings that need a new controller when they change. Persona text doesn't:
 * the system prompt is rebuilt from the latest bot on every model call. */
async function signatureOf(bot: Bot): Promise<string> {
  // The model isn't here: it's chosen for every call, so a model switch applies
  // to the next reply without dropping any sessions. Connections are, along
  // with a version that bumps when any app or server changes. Permissions are,
  // because they are applied when a session is created.
  return JSON.stringify({
    tools: bot.tools,
    approval: bot.approval,
    toolPolicy: bot.toolPolicy,
    role: bot.role,
    connections: bot.connections,
    connectionsVersion: bot.connections.length ? await connectionsVersion() : 0,
    mock: isMock(),
  });
}

/** A Browserbase cloud browser, reached over CDP. The session starts on the
 * bot's first browser action and is released when its controller closes. */
async function createBrowser(bot: Bot): Promise<MastraBrowser | undefined> {
  if (!bot.tools.browser) return undefined;
  const { AgentBrowser } = await import("@mastra/agent-browser");
  const model = isMock() ? undefined : await findModel(bot.model);
  return new AgentBrowser({
    cdpUrl: () => createSession(bot.id),
    scope: "shared",
    onLaunch: () => announceLiveView(bot.id),
    onClose: () => releaseSession(bot.id),
    // A screenshot comes back as an image, which text-only models can't read.
    excludeTools: model?.vision ? [] : ["browser_screenshot"],
  }) as unknown as MastraBrowser;
}

/** What a turn passes to the model and tools through Mastra's request context. */
interface TurnSettings {
  model?: string;
  conversationId?: ConversationId;
}

function settingsOf(requestContext: unknown): TurnSettings {
  const rc = requestContext as { get?: (key: string) => unknown } | undefined;
  return (rc?.get?.("opencrewbot") as TurnSettings | undefined) ?? {};
}

async function buildRuntime(bot: Bot): Promise<BotRuntime> {
  const holder = { bot };
  const memory = new Memory({ storage: state.storage, options: { lastMessages: 40 } });
  const builtIn = buildTools(bot);
  const connectors = await buildConnectorTools(bot, `bot-${bot.id}-${Date.now()}`);
  const capabilities = [...builtIn.capabilities, ...connectors.capabilities];
  const agent = new Agent({
    id: `bot-${bot.id}`,
    name: bot.name,
    instructions: (async ({ requestContext }: { requestContext?: unknown }) => {
      const conversationId = settingsOf(requestContext).conversationId;
      const room = conversationId?.startsWith("room:") ? await getRoom(conversationId.slice("room:".length)) : null;
      return systemPrompt(holder.bot, capabilities, builtIn.instructions, room);
    }) as never,
    // The model is chosen per turn (see executeTurn) and arrives through the request
    // context. The original app always used `nebius/<model>`.
    model: isMock()
      ? createMockModel(bot.name)
      : ((({ requestContext }: { requestContext?: unknown }) => routerConfig(settingsOf(requestContext).model ?? holder.bot.model)) as never),
    tools: { ...connectors.tools, ...builtIn.tools },
    memory,
  });
  const browser = await createBrowser(bot);
  const controller = new AgentController({
    id: `controller-${bot.id}`,
    agent,
    storage: state.storage,
    modes: [{ id: "chat", name: "Chat", metadata: { default: true } }],
    browser,
    toolCategoryResolver: toolCategory,
    disableBuiltinTools: [
      "submit_plan",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "subagent",
      ...(bot.tools.askUser ? [] : (["ask_user"] as const)),
    ],
  });
  return { signature: await signatureOf(bot), holder, controller, ready: controller.init(), closeConnectors: connectors.close };
}

function isBotBusy(botId: string): boolean {
  for (const bots of state.running.values()) if (bots.has(botId)) return true;
  return false;
}

async function dropRuntime(botId: string): Promise<void> {
  const runtime = state.runtimes.get(botId);
  if (!runtime) return;
  state.runtimes.delete(botId);
  for (const k of [...state.sessions.keys()]) if (k.endsWith(`|${botId}`)) state.sessions.delete(k);
  await runtime.controller.destroy().catch(() => {});
  await runtime.closeConnectors().catch(() => {});
  await releaseSession(botId);
}

async function runtimeFor(bot: Bot): Promise<BotRuntime> {
  let runtime = state.runtimes.get(bot.id);
  if (runtime && runtime.signature !== (await signatureOf(bot)) && !isBotBusy(bot.id)) {
    await dropRuntime(bot.id);
    runtime = undefined;
  }
  if (!runtime) {
    runtime = await buildRuntime(bot);
    state.runtimes.set(bot.id, runtime);
  }
  runtime.holder.bot = bot;
  await runtime.ready;
  return runtime;
}

async function sessionFor(bot: Bot, conversationId: ConversationId): Promise<Session> {
  const runtime = await runtimeFor(bot);
  const generation = await conversationGeneration(conversationId);
  const threadId = `${conversationId}:${bot.id}:${generation}`;
  const k = key(conversationId, bot.id);
  const cached = state.sessions.get(k);
  if (cached && cached.thread.getId() === threadId) return cached;
  const session = await runtime.controller.createSession({ resourceId: OWNER_ID, scope: conversationId, threadId });
  await session.permissions.setForCategory({ category: "read", policy: "allow" });
  await session.permissions.setForCategory({ category: "edit", policy: "allow" });
  await session.permissions.setForCategory({ category: "other", policy: "allow" });
  // Connected apps, MCP servers and the browser act on real accounts: ask first unless the
  // bot has full access. (Controlled access asks too, except for tools you pre-approved below.)
  const sensitive = bot.approval === "full" ? "allow" : "ask";
  await session.permissions.setForCategory({ category: "mcp", policy: sensitive });
  await session.permissions.setForCategory({ category: "execute", policy: sensitive });
  // Per-tool overrides. External native tools (email, Slack, Notion, GitHub issues) are
  // checked by the approval gate inside the tool, which also knows the Controlled limits,
  // so they are left to it here to avoid asking twice.
  for (const [toolName, policy] of Object.entries(bot.toolPolicy)) {
    if (TOOL_META.get(toolName)?.risk === "external") continue;
    await session.permissions.setForTool({ toolName, policy });
  }
  state.sessions.set(k, session);
  return session;
}

// ── running state ──────────────────────────────────────────────────────

function setRunning(conversationId: ConversationId, botId: string, on: boolean) {
  const bots = state.running.get(conversationId) ?? new Set<string>();
  if (on) bots.add(botId);
  else bots.delete(botId);
  if (bots.size) state.running.set(conversationId, bots);
  else state.running.delete(conversationId);
  publish({ type: "running", conversationId, botIds: [...bots] });
}

/** Changes whenever Stop is pressed in this conversation. */
export function stopEpochOf(conversationId: ConversationId): number {
  return state.stopEpoch.get(conversationId) ?? 0;
}

export function runningBots(conversationId: ConversationId): string[] {
  return [...(state.running.get(conversationId) ?? [])];
}

export function isRunning(conversationId: ConversationId, botId: string): boolean {
  return state.running.get(conversationId)?.has(botId) ?? false;
}

// ── folding controller events into one chat message per turn ────────────

class TurnFolder {
  readonly message: ChatMessage;
  private textPart = new Map<string, number>();
  private reasoningPart = new Map<string, number>();
  private toolPart = new Map<string, number>();
  private toolArgs = new Map<string, unknown>();
  private input = 0;
  private output = 0;
  private resolveDone!: (m: ChatMessage) => void;
  readonly done = new Promise<ChatMessage>((r) => (this.resolveDone = r));
  finished = false;
  /** When another model can still be tried, a provider error is held here instead of ending the turn. */
  softFailure: string | null = null;
  canFallBack = false;

  constructor(
    conversationId: ConversationId,
    private readonly bot: Bot,
    route: RouteNote | undefined,
    private readonly request: TurnRequest,
  ) {
    this.message = {
      id: randomUUID(),
      conversationId,
      role: "bot",
      botId: bot.id,
      createdAt: new Date().toISOString(),
      status: "streaming",
      parts: [],
      model: isMock() ? "mock" : bot.model,
      route,
      simulated: isMock() || undefined,
    };
  }

  private emit(persist = false) {
    publish({ type: "message", message: this.message });
    if (persist) void saveMessage(this.message);
  }

  /** True once the model has produced anything the person can see. */
  hasContent(): boolean {
    return this.message.parts.some((p) => (p.kind === "text" && p.text.trim()) || p.kind === "tool" || p.kind === "question");
  }

  private streamInto(kind: "text" | "reasoning", sourceId: string, delta: string) {
    const index = kind === "text" ? this.textPart : this.reasoningPart;
    let i = index.get(sourceId);
    const last = this.message.parts.length - 1;
    // Start a new part when another part (a tool call) came in between.
    if (i === undefined || i !== last) {
      this.message.parts.push({ kind, text: "" });
      i = this.message.parts.length - 1;
      index.set(sourceId, i);
      this.emit();
    }
    const part = this.message.parts[i] as { text: string };
    part.text += delta;
    publish({ type: "delta", conversationId: this.message.conversationId, messageId: this.message.id, partIndex: i, kind, delta });
  }

  private tool(toolCallId: string): Extract<Part, { kind: "tool" }> | undefined {
    const i = this.toolPart.get(toolCallId);
    return i === undefined ? undefined : (this.message.parts[i] as Extract<Part, { kind: "tool" }>);
  }

  /** The approval gate inside a native tool shows or clears the Allow / Deny buttons. */
  markAwaiting(toolCallId: string, waiting: boolean, preview?: string) {
    const part = this.tool(toolCallId);
    if (!part) return;
    part.status = waiting ? "awaiting-approval" : "running";
    if (preview) part.preview = preview;
    this.emit(true);
  }

  waitingOnPerson(): boolean {
    return this.message.parts.some(
      (p) => (p.kind === "tool" && p.status === "awaiting-approval") || (p.kind === "question" && p.answer === undefined),
    );
  }

  handle(event: AgentControllerEvent) {
    if (this.finished) return;
    switch (event.type) {
      case "message_update": {
        if (event.event.type === "text-delta") this.streamInto("text", event.id, event.event.delta);
        else if (event.event.type === "reasoning-delta") this.streamInto("reasoning", event.id, event.event.delta);
        break;
      }
      case "tool_start": {
        if (event.toolName === "ask_user" || this.toolPart.has(event.toolCallId)) break;
        const { label, detail } = toolLabel(event.toolName, event.args);
        this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "running" });
        this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
        this.toolArgs.set(event.toolCallId, event.args);
        this.emit(true);
        break;
      }
      case "tool_approval_required": {
        let part = this.tool(event.toolCallId);
        if (!part) {
          const { label, detail } = toolLabel(event.toolName, event.args);
          this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "awaiting-approval" });
          this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
          part = this.tool(event.toolCallId);
        }
        part!.status = "awaiting-approval";
        part!.preview = JSON.stringify(event.args ?? {}, null, 2).slice(0, 4000);
        this.toolArgs.set(event.toolCallId, event.args);
        this.request.onWaiting?.(true);
        // Mastra raised this approval (browser, MCP and Composio tools). Put it in the approval centre too.
        const args = (event.args ?? {}) as Record<string, unknown>;
        const { label, detail } = toolLabel(event.toolName, args);
        void recordApproval({
          conversationId: this.message.conversationId,
          botId: this.bot.id,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          title: `${label}${detail ? `: ${detail}` : ""}`,
          preview: JSON.stringify(args, null, 2).slice(0, 6000),
          args,
          planId: this.request.context?.planId,
          taskId: this.request.context?.taskId,
          note: this.bot.approval === "controlled" ? "Controlled access: not a pre-approved action" : "Ask first",
        });
        this.emit(true);
        break;
      }
      case "tool_suspended": {
        if (event.toolName !== "ask_user") break;
        const payload = (event.suspendPayload ?? {}) as { question?: string; options?: { label: string; description?: string }[] };
        this.message.parts.push({
          kind: "question",
          toolCallId: event.toolCallId,
          question: payload.question ?? String((event.args as { question?: string })?.question ?? "The bot has a question."),
          options: payload.options ?? [],
        });
        this.request.onWaiting?.(true);
        this.emit(true);
        break;
      }
      case "tool_end": {
        const part = this.tool(event.toolCallId);
        if (!part) break;
        const result = event.result as { executed?: boolean; rejected?: boolean; denied?: boolean; cancelled?: boolean; simulated?: boolean } | null;
        // A native tool the approval gate refused comes back as a normal result that says so.
        const refused = Boolean(result && result.executed === false && (result.rejected || result.denied || result.cancelled));
        const wasAwaiting = part.status === "awaiting-approval";
        part.status = event.denied || refused ? "denied" : event.isError ? "error" : "done";
        part.preview = toolPreview(event.result);
        part.sources = toolSources(event.result);
        if (wasAwaiting) this.request.onWaiting?.(false);
        const category = toolCategory(part.name);
        if (!TOOL_META.has(part.name) && (category === "mcp" || category === "execute")) {
          // Browser, MCP and Composio actions: record what actually happened.
          void audit({
            event: event.denied ? "rejected" : event.isError ? "failed" : "executed",
            botId: this.bot.id,
            botName: this.bot.name,
            tool: part.name,
            detail: event.denied ? `${part.label}: rejected. The action was NOT executed.` : `${part.label}${part.detail ? `: ${part.detail}` : ""}`,
            conversationId: this.message.conversationId,
            planId: this.request.context?.planId,
            taskId: this.request.context?.taskId,
          });
        }
        this.emit(true);
        break;
      }
      case "usage_update": {
        const u = event.usage as { promptTokens?: number; completionTokens?: number };
        this.input += u.promptTokens ?? 0;
        this.output += u.completionTokens ?? 0;
        break;
      }
      case "error": {
        this.message.error = event.error?.message || "The model returned an error.";
        break;
      }
      case "agent_end": {
        if (event.reason === "suspended") {
          this.emit(true);
          break;
        }
        if (event.reason === "error" && this.canFallBack && !this.hasContent()) {
          // Nothing was produced: let executeTurn try the next model instead of ending here.
          this.softFailure = this.message.error || "The model returned an error.";
          break;
        }
        void this.finish(event.reason === "aborted" ? "stopped" : event.reason === "error" ? "error" : "done");
        break;
      }
    }
  }

  answer(toolCallId: string, answer: string) {
    const part = this.message.parts.find((p) => p.kind === "question" && p.toolCallId === toolCallId);
    if (part && part.kind === "question") part.answer = answer;
    this.request.onWaiting?.(false);
    this.emit(true);
  }

  /** Clear a held provider error before another model is tried. */
  resetForRetry(nextModel: string, failedModel: string) {
    this.softFailure = null;
    this.message.error = undefined;
    this.message.fallbackFrom = this.message.fallbackFrom ?? failedModel;
    this.message.model = nextModel;
    this.message.parts = this.message.parts.filter((p) => p.kind !== "reasoning");
    this.textPart.clear();
    this.reasoningPart.clear();
    this.emit();
  }

  async finish(status: ChatMessage["status"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    if (error) this.message.error = error;
    if (this.message.error && status === "done" && !this.message.parts.some((p) => p.kind === "text" && p.text.trim())) {
      status = "error";
    }
    this.message.status = status;
    for (const p of this.message.parts) {
      if (p.kind === "tool" && (p.status === "running" || p.status === "awaiting-approval")) {
        p.status = status === "stopped" ? "denied" : "error";
      }
    }
    if (this.message.model !== "mock") {
      const model = this.message.model ?? "";
      const cost = costOf(model, this.input, this.output);
      const known = await findModel(model);
      this.message.usage = { input: this.input, output: this.output, costUsd: known && known.inputPerM !== null ? cost : null };
      if (this.input || this.output) {
        void addUsage({
          id: randomUUID(),
          at: new Date().toISOString(),
          botId: this.bot.id,
          model,
          input: this.input,
          output: this.output,
          costUsd: cost,
          planId: this.request.context?.planId,
          purpose: this.request.context?.taskId ? "task" : this.message.conversationId.startsWith("room:") ? "room" : "chat",
        }).catch(() => {});
      }
    } else {
      this.message.usage = { input: this.input, output: this.output, costUsd: null };
    }
    await saveMessage(this.message);
    publish({ type: "message", message: this.message });
    this.resolveDone(this.message);
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface TurnRequest {
  bot: Bot;
  conversationId: ConversationId;
  /** What the bot receives: the person's words, or a room's catch-up text. */
  content: string;
  route?: RouteNote;
  /** The plan and task this turn works on, when the execution engine started it. */
  context?: { planId?: string; taskId?: string };
  /** How heavy the work is, for bots on automatic model routing. */
  tier?: RoutingTier;
  /** Models to skip, e.g. one that already failed this task. */
  avoidModels?: string[];
  /** Called when the turn starts or stops waiting on the person (approval or question). */
  onWaiting?: (waiting: boolean) => void;
}

/** Queue one turn for one bot in one conversation and resolve with its reply,
 * or null when Stop cancelled it before it started. */
export function runTurn(request: TurnRequest): Promise<ChatMessage | null> {
  const k = key(request.conversationId, request.bot.id);
  const epoch = state.stopEpoch.get(request.conversationId) ?? 0;
  const previous = state.chains.get(k) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => ((state.stopEpoch.get(request.conversationId) ?? 0) === epoch ? executeTurn(request) : null));
  state.chains.set(k, next);
  void next.finally(() => {
    if (state.chains.get(k) === next) state.chains.delete(k);
  });
  return next;
}

/** The models to try for this turn, best first. Empty in mock mode. */
async function modelsFor(bot: Bot, request: TurnRequest): Promise<string[]> {
  if (isMock()) return [];
  const tier = request.tier ?? "balanced";
  const primary = bot.modelMode === "auto" ? await modelForTier(tier) : bot.model;
  const chain = await modelChain(primary, bot.fallbackModels, tier);
  const avoid = new Set(request.avoidModels ?? []);
  const preferred = chain.filter((m) => !avoid.has(m));
  return preferred.length ? [...preferred, ...chain.filter((m) => avoid.has(m))] : chain;
}

async function executeTurn(request: TurnRequest): Promise<ChatMessage> {
  const { bot, conversationId, content, route } = request;
  const latest = (await getBot(bot.id)) ?? bot;
  const k = key(conversationId, latest.id);
  const folder = new TurnFolder(conversationId, latest, route, request);
  const abort = new AbortController();
  state.aborts.set(k, abort);
  const turn: TurnContext = {
    conversationId,
    botId: latest.id,
    planId: request.context?.planId,
    taskId: request.context?.taskId,
    actions: 0,
    signal: abort.signal,
    markAwaiting: (toolCallId, waiting, preview) => folder.markAwaiting(toolCallId, waiting, preview),
    onWaiting: request.onWaiting,
  };
  setTurn(turn);
  setRunning(conversationId, latest.id, true);
  state.folders.set(k, folder);
  await saveMessage(folder.message);
  publish({ type: "message", message: folder.message });

  let unsubscribe: (() => void) | undefined;
  try {
    const models = await modelsFor(latest, request);
    if (!isMock() && models.length === 0) throw new Error("No model is available. Add a provider key to .env (see the Models page) and restart.");
    const session = await sessionFor(latest, conversationId);
    unsubscribe = session.subscribe((event) => folder.handle(event));
    const attempts = isMock() ? ["mock"] : models;
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      folder.canFallBack = i < attempts.length - 1;
      if (!isMock()) folder.message.model = model;
      const requestContext = new RequestContext();
      requestContext.set("opencrewbot", { model: isMock() ? undefined : model, conversationId });
      let thrown: string | null = null;
      try {
        await session.sendMessage({ content, requestContext });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      if (abort.signal.aborted || folder.finished) break;
      const failure = folder.softFailure ?? (thrown && !folder.hasContent() ? thrown : null);
      if (failure && folder.canFallBack) {
        await audit({ event: "model-fallback", botId: latest.id, botName: latest.name, detail: `${model} failed (${failure.slice(0, 200)}); trying ${attempts[i + 1]}.`, conversationId, planId: turn.planId, taskId: turn.taskId });
        markModelFailed(model);
        folder.resetForRetry(attempts[i + 1], model);
        continue;
      }
      if (thrown) throw new Error(thrown);
      break;
    }
    // The run settled. If no terminal event reached us and nothing waits on the
    // person, close the turn here so it never hangs as "streaming".
    if (!folder.finished && !folder.waitingOnPerson()) await folder.finish(folder.softFailure ? "error" : "done", folder.softFailure ?? undefined);
    return await folder.done;
  } catch (error) {
    await folder.finish("error", error instanceof Error ? error.message : String(error));
    return folder.message;
  } finally {
    unsubscribe?.();
    if (state.folders.get(k) === folder) state.folders.delete(k);
    if (state.aborts.get(k) === abort) state.aborts.delete(k);
    clearTurn(conversationId, latest.id);
    setRunning(conversationId, latest.id, false);
  }
}

/** Answer an approval request, whichever mechanism raised it: the approval gate inside a
 * native tool, or Mastra's own approval for browser, MCP and Composio tools. */
export async function respondToApproval(conversationId: ConversationId, botId: string, toolCallId: string, approve: boolean) {
  const pending = await pendingFor(conversationId, botId, toolCallId);
  if (pending) {
    await settleApproval(pending.id, approve ? "approved" : "rejected", "you");
    if (releaseGate(pending.id, approve ? "approved" : "rejected")) return;
  }
  const session = state.sessions.get(key(conversationId, botId));
  if (!session) throw new Error("That request is no longer waiting. The bot may have restarted.");
  await session.respondToToolApproval({ toolCallId, decision: approve ? "approve" : "decline" });
}

export async function answerQuestion(conversationId: ConversationId, botId: string, toolCallId: string, answer: string) {
  const k = key(conversationId, botId);
  const session = state.sessions.get(k);
  if (!session) throw new Error("That question is no longer waiting. The bot may have restarted.");
  state.folders.get(k)?.answer(toolCallId, answer);
  await session.respondToToolSuspension({ toolCallId, resumeData: answer });
}

async function stopOne(k: string) {
  const session = state.sessions.get(k);
  const folder = state.folders.get(k);
  // Aborting first releases any approval gate that is waiting: it resolves as cancelled,
  // so the action it guards is not carried out.
  state.aborts.get(k)?.abort();
  try {
    session?.abort();
  } catch {
    // nothing running
  }
  // A run parked on an approval or question has no live stream to abort.
  if (folder && !folder.finished) await folder.finish("stopped");
}

export async function stopConversation(conversationId: ConversationId) {
  state.stopEpoch.set(conversationId, (state.stopEpoch.get(conversationId) ?? 0) + 1);
  for (const k of new Set([...state.sessions.keys(), ...state.folders.keys()])) {
    if (k.startsWith(`${conversationId}|`)) await stopOne(k);
  }
}

/** Stop one bot's turn in one conversation (task timeout or cancellation), leaving the others running. */
export async function stopTurn(conversationId: ConversationId, botId: string) {
  await stopOne(key(conversationId, botId));
}

/** Forget a bot's controller, e.g. after it's deleted or its settings change. */
export async function resetBot(botId: string) {
  if (!isBotBusy(botId)) await dropRuntime(botId);
}

/** Drop cached sessions so the next turn starts a fresh model-side thread. */
export function forgetConversation(conversationId: ConversationId) {
  for (const k of [...state.sessions.keys()]) if (k.startsWith(`${conversationId}|`)) state.sessions.delete(k);
}

/** Post a message from a bot without calling a model: plan cards, notices from the engine. */
export async function postBotMessage(conversationId: ConversationId, botId: string, parts: Part[], route?: RouteNote, extra: Partial<ChatMessage> = {}): Promise<ChatMessage> {
  const message: ChatMessage = { id: randomUUID(), conversationId, role: "bot", botId, createdAt: new Date().toISOString(), status: "done", parts, route, ...extra };
  await saveMessage(message);
  publish({ type: "message", message });
  return message;
}

export async function postNotice(conversationId: ConversationId, text: string): Promise<ChatMessage> {
  const message: ChatMessage = { id: randomUUID(), conversationId, role: "notice", createdAt: new Date().toISOString(), status: "done", parts: [{ kind: "text", text }] };
  await saveMessage(message);
  publish({ type: "message", message });
  return message;
}

/** Show a bot as working while something outside a turn runs (the Chief planning). */
export function markBusy(conversationId: ConversationId, botId: string, on: boolean) {
  setRunning(conversationId, botId, on);
}
