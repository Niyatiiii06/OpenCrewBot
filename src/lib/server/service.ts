// What the API routes call. Keeps validation and side effects in one place.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, BotInput, ChatMessage, ConversationId, ConversationSummary, Room, RoomInput } from "@/lib/shared/types";
import { DATA_DIR } from "./config";
import { InputError } from "./errors";
import * as store from "./db";
import { publish } from "./bus";
import { DEFAULT_MODEL } from "./models";
import { deleteRoomMemory, deleteWorkspace, writeMemory } from "./memory-files";
import { forgetConversation, resetBot, runTurn, runningBots, stopConversation } from "./runtime";
import { activePlanIn, amendPlan, cancelPlan, lastPlanIn, recoverPlans, resumePlan, startPlan } from "./engine";
import { expirePendingApprovals } from "./permissions";
import { applyKeyAliases } from "./providers";
import { recoverWorkflowRuns, startScheduler } from "./workflows";
import { messagePreview } from "@/lib/shared/preview";
import { roomConversationId, runRoom } from "./rooms";

export { InputError };

// ── seeding and restart cleanup (once per process) ──────────────────────

const g = globalThis as unknown as { __opencrewbotBoot?: Promise<void> };

export function boot(): Promise<void> {
  g.__opencrewbotBoot ??= (async () => {
    applyKeyAliases();
    await sweepInterrupted();
    // Approvals that were waiting when the server stopped can never be granted late.
    await expirePendingApprovals();
    await seed();
    await recoverPlans();
    await recoverWorkflowRuns();
    startScheduler();
  })();
  return g.__opencrewbotBoot;
}

/** A turn that was streaming when the server stopped can't resume. Say so. */
async function sweepInterrupted() {
  const client = await store.db();
  const rows = await client.execute(`SELECT data FROM messages WHERE data LIKE '%"status":"streaming"%'`);
  for (const r of rows.rows) {
    const m = JSON.parse(String(r.data)) as ChatMessage;
    if (m.status !== "streaming") continue;
    m.status = "stopped";
    m.error = "Interrupted by a server restart.";
    for (const p of m.parts) if (p.kind === "tool" && (p.status === "running" || p.status === "awaiting-approval")) p.status = "denied";
    await store.saveMessage(m);
  }
}

const SEED_MARKER = join(DATA_DIR, ".seeded-v2");

type SeedBot = Omit<BotInput, "model" | "pinned" | "approval" | "tools" | "color"> & Partial<Pick<BotInput, "approval" | "pinned">> & { color: string; tools: Partial<Bot["tools"]> };

const SEED_TOOLS: Bot["tools"] = { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true, collaboration: true, dataAnalysis: false, github: false, email: false, slack: false, notion: false, artifacts: true };

const SEED_BOTS: SeedBot[] = [
  {
    name: "Chief",
    title: "Chief of Staff",
    role: "chief",
    description: "Turns one instruction into a task plan, assigns the right agents, tracks the work and writes the final answer.",
    instructions: "You run the team. Split large requests into clear tasks, give each to the agent whose tools fit, run independent tasks in parallel, and consolidate only what the tasks produced. Answer simple questions yourself.",
    emoji: "🧑‍✈️",
    color: "#111827",
    tools: {},
    skills: ["daily-summary"],
    outputFormat: "Summary first, then sections. End with what was not completed, if anything.",
    pinned: true,
  },
  {
    name: "Scout",
    title: "Research",
    description: "Finds things out on the web and comes back with sourced answers.",
    instructions: "Research before answering anything time-sensitive. Search, read the best two or three sources, then answer with the URLs you used. Say plainly when sources disagree or you couldn't verify something.",
    emoji: "🔭",
    color: "#2f7df6",
    tools: { webSearch: true, codeMode: true },
    skills: ["market-research", "competitor-analysis"],
    outputFormat: "Findings as bullets, each with its source link.",
  },
  {
    name: "Quill",
    title: "Content",
    description: "Turns notes and research into campaigns, content calendars, posts and emails.",
    instructions: "Write in plain, specific language. Match the person's voice once you know it, and keep their style preferences in memory. Offer one tight draft, not three options.",
    emoji: "✒️",
    color: "#e0663d",
    tools: {},
    skills: ["campaign-strategy", "content-calendar", "email-drafting"],
    outputFormat: "Strategy in a few lines, then the plan as a Markdown table.",
  },
  {
    name: "Atlas",
    title: "Strategy",
    description: "Shapes positioning, pricing and plans; turns findings into decisions and presentations.",
    instructions: "Turn findings into a clear recommendation with the reasoning and the trade-offs. Record decisions in memory with scope 'decision'.",
    emoji: "🧭",
    color: "#1f9d6b",
    tools: { webSearch: true },
    skills: ["financial-modelling", "presentation-creation"],
    outputFormat: "Recommendation, reasoning, risks, next steps.",
  },
  {
    name: "Dex",
    title: "Data analysis",
    description: "Analyses spreadsheets, calculates metrics and funnels, and draws charts.",
    instructions: "Compute every number with analyze_spreadsheet or code; never estimate. Show the calculation behind each headline number and name data-quality problems.",
    emoji: "📊",
    color: "#7a5af5",
    tools: { dataAnalysis: true, codeMode: true },
    skills: ["data-analysis"],
    outputFormat: "Headline numbers, a table per breakdown, the charts, then recommendations tied to the numbers.",
  },
  {
    name: "Forge",
    title: "Engineering",
    description: "Inspects GitHub repositories, reviews code and proposes changes as issues.",
    instructions: "Inspect before you comment. Cite the file for every finding. Propose changes as issues and wait for approval; never change a repository on your own.",
    emoji: "🛠️",
    color: "#475569",
    tools: { github: true, webSearch: true },
    skills: ["code-review", "repo-monitoring"],
    outputFormat: "Findings by severity, each with file, evidence and suggested fix.",
  },
  {
    name: "Echo",
    title: "Outreach",
    description: "Drafts and sends email, and posts updates to Slack and Notion. Controlled access.",
    instructions: "Write short, specific messages. Show the draft, then send. If the person rejects a send, do not retry: report that it was not sent.",
    emoji: "📨",
    color: "#d9488b",
    tools: { email: true, slack: true, notion: true },
    skills: ["email-drafting", "lead-generation"],
    approval: "controlled",
    outputFormat: "Subject, body, then one line on what was sent or not sent.",
  },
  {
    name: "Vera",
    title: "Review and QA",
    description: "Verifies claims and checks work against its sources before it ships.",
    instructions:
      "Check each claim against its source. Re-run any numbers yourself with analyze_spreadsheet or code rather than asking for the data; the files the author used are available to you too. Start with VERIFIED or NEEDS CHANGES, then list each problem with the evidence. If you cannot check something, say so.",
    emoji: "🧪",
    color: "#b45309",
    tools: { webSearch: true, dataAnalysis: true, codeMode: true },
    skills: [],
    outputFormat: "First line VERIFIED or NEEDS CHANGES, then numbered issues.",
  },
  {
    name: "Sage",
    title: "Reporting",
    description: "Writes daily summaries and status reports. Full access to its own tools.",
    instructions: "Summarise what happened, what changed and what needs a decision. Keep it to one screen.",
    emoji: "🗂️",
    color: "#0891b2",
    tools: { slack: true },
    skills: ["daily-summary", "presentation-creation"],
    approval: "full",
    outputFormat: "Three sections: done, changed, needs a decision.",
  },
];

const SEED_ROOMS: { name: string; topic: string; emoji: string; members: string[]; responder: Room["responder"]; pinned?: boolean }[] = [
  { name: "Command Room", topic: "Give the Chief of Staff any business problem", emoji: "🎯", members: ["Chief", "Scout", "Quill", "Atlas", "Dex", "Forge", "Echo", "Vera", "Sage"], responder: "chief", pinned: true },
  { name: "Market Intelligence", topic: "Markets, competitors and trends", emoji: "🌍", members: ["Chief", "Scout", "Atlas", "Vera", "Sage"], responder: "chief" },
  { name: "Campaign Studio", topic: "Campaigns, content calendars and launches", emoji: "🎬", members: ["Chief", "Quill", "Scout", "Atlas", "Vera"], responder: "chief" },
  { name: "Sales and Data", topic: "Pipeline, spreadsheets and outreach", emoji: "📈", members: ["Chief", "Dex", "Echo", "Atlas", "Vera"], responder: "chief" },
  { name: "Engineering", topic: "Repositories and code review", emoji: "⚙️", members: ["Chief", "Forge", "Vera"], responder: "chief" },
  { name: "Studio", topic: "Open chat: mention an agent or let the lead answer", emoji: "💬", members: ["Atlas", "Scout", "Quill"], responder: "auto" },
];

/** First run: a Chief of Staff, eight specialists and six rooms. Existing agents and
 * rooms (from the original app's data) are kept; only missing ones are added. */
async function seed() {
  if (existsSync(SEED_MARKER)) return;
  const byName = new Map((await store.listBots()).map((b) => [b.name, b]));
  for (const def of SEED_BOTS) {
    if (byName.has(def.name)) continue;
    const bot = await createBot({ approval: "ask", pinned: false, ...def, model: DEFAULT_MODEL, modelMode: "auto", tools: { ...SEED_TOOLS, ...def.tools }, createdBy: "seed" });
    byName.set(bot.name, bot);
  }
  const rooms = new Set((await store.listRooms()).map((r) => r.name));
  for (const def of SEED_ROOMS) {
    if (rooms.has(def.name)) continue;
    const memberIds = def.members.map((n) => byName.get(n)?.id).filter((id): id is string => Boolean(id));
    await createRoom({ name: def.name, topic: def.topic, emoji: def.emoji, memberIds, leadId: memberIds[0] ?? null, responder: def.responder, pinned: Boolean(def.pinned) });
  }
  writeFileSync(SEED_MARKER, new Date().toISOString());
}

// ── bots ────────────────────────────────────────────────────────────────

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "bot";
}

async function uniqueHandle(wanted: string, exceptId?: string): Promise<string> {
  const taken = new Set((await store.listBots()).filter((b) => b.id !== exceptId).map((b) => b.handle));
  const base = slug(wanted);
  let handle = base;
  for (let n = 2; taken.has(handle) || ["everyone", "all"].includes(handle); n++) handle = `${base}${n}`;
  return handle;
}

function validateBot(input: Partial<BotInput>) {
  if (input.name !== undefined && !input.name.trim()) throw new InputError("A bot needs a name.");
  if (input.name && input.name.length > 40) throw new InputError("Keep the name under 40 characters.");
  if (input.instructions && input.instructions.length > 8000) throw new InputError("Instructions are limited to 8,000 characters.");
}

export async function createBot(input: BotInput): Promise<Bot> {
  validateBot(input);
  const bot = store.normalizeBot({
    createdBy: "user",
    ...input,
    id: randomUUID().slice(0, 8),
    name: input.name.trim(),
    connections: input.connections ?? [],
    handle: await uniqueHandle(input.handle || input.name),
    createdAt: new Date().toISOString(),
  } as Bot);
  await store.saveBot(bot);
  writeMemory(bot.id, `# ${bot.name}'s memory\n\n`);
  publish({ type: "bots-changed" });
  return bot;
}

export async function updateBot(id: string, patch: Partial<BotInput>): Promise<Bot> {
  const bot = await store.getBot(id);
  if (!bot) throw new InputError("That bot doesn't exist.");
  validateBot(patch);
  const next: Bot = {
    ...bot,
    ...patch,
    id: bot.id,
    createdAt: bot.createdAt,
    tools: { ...bot.tools, ...(patch.tools ?? {}) },
    limits: { ...bot.limits, ...(patch.limits ?? {}) },
    handle: patch.handle !== undefined || patch.name !== undefined ? await uniqueHandle(patch.handle || patch.name || bot.handle, id) : bot.handle,
  };
  await store.saveBot(next);
  await resetBot(id);
  publish({ type: "bots-changed" });
  return next;
}

export async function deleteBot(id: string): Promise<void> {
  await stopConversation(`dm:${id}`);
  await resetBot(id);
  await store.deleteBotRow(id);
  await store.clearMessages(`dm:${id}`);
  for (const room of await store.listRooms()) {
    if (!room.memberIds.includes(id)) continue;
    const memberIds = room.memberIds.filter((m) => m !== id);
    await store.saveRoom({ ...room, memberIds, leadId: room.leadId === id ? (memberIds[0] ?? null) : room.leadId });
  }
  deleteWorkspace(id);
  publish({ type: "bots-changed" });
  publish({ type: "rooms-changed" });
}

// ── rooms ───────────────────────────────────────────────────────────────

async function cleanRoomInput<T extends Partial<RoomInput>>(input: T): Promise<T> {
  if (input.name !== undefined && !input.name.trim()) throw new InputError("A room needs a name.");
  if (input.memberIds) {
    const known = new Set((await store.listBots()).map((b) => b.id));
    input.memberIds = [...new Set(input.memberIds)].filter((id) => known.has(id));
  }
  return input;
}

export async function createRoom(input: RoomInput): Promise<Room> {
  const clean = await cleanRoomInput(input);
  const room: Room = {
    ...clean,
    id: randomUUID().slice(0, 8),
    name: clean.name.trim(),
    leadId: clean.leadId && clean.memberIds.includes(clean.leadId) ? clean.leadId : (clean.memberIds[0] ?? null),
    createdAt: new Date().toISOString(),
  };
  await store.saveRoom(room);
  publish({ type: "rooms-changed" });
  return room;
}

export async function updateRoom(id: string, patch: Partial<RoomInput>): Promise<Room> {
  const room = await store.getRoom(id);
  if (!room) throw new InputError("That room doesn't exist.");
  const clean = await cleanRoomInput(patch);
  const next: Room = { ...room, ...clean, id: room.id, createdAt: room.createdAt };
  if (!next.leadId || !next.memberIds.includes(next.leadId)) next.leadId = next.memberIds[0] ?? null;
  await store.saveRoom(next);
  publish({ type: "rooms-changed" });
  return next;
}

export async function deleteRoom(id: string): Promise<void> {
  const conversationId = roomConversationId(id);
  await stopConversation(conversationId);
  await store.deleteRoomRow(id);
  await store.clearMessages(conversationId);
  deleteRoomMemory(id);
  publish({ type: "rooms-changed" });
}

// ── conversations ───────────────────────────────────────────────────────

function parseConversation(conversationId: ConversationId): { kind: "dm" | "room"; id: string } {
  const [kind, id] = conversationId.split(":");
  if ((kind !== "dm" && kind !== "room") || !id) throw new InputError("Unknown conversation.");
  return { kind, id };
}

export async function sendMessage(conversationId: ConversationId, text: string): Promise<ChatMessage> {
  const content = text.trim();
  if (!content) throw new InputError("Type a message first.");
  if (content.length > 20000) throw new InputError("Messages are limited to 20,000 characters.");
  const { kind, id } = parseConversation(conversationId);

  const bot = kind === "dm" ? await store.getBot(id) : null;
  const room = kind === "room" ? await store.getRoom(id) : null;
  if (kind === "dm" && !bot) throw new InputError("That bot doesn't exist.");
  if (kind === "room" && !room) throw new InputError("That room doesn't exist.");
  if (room && room.memberIds.length === 0) throw new InputError("Add at least one bot to this room first.");

  const message: ChatMessage = {
    id: randomUUID(),
    conversationId,
    role: "user",
    createdAt: new Date().toISOString(),
    status: "done",
    parts: [{ kind: "text", text: content }],
  };
  await store.saveMessage(message);
  await store.markRead(conversationId);
  publish({ type: "message", message });

  // The reply streams over SSE; the request returns as soon as it's queued.
  if (bot) void directMessage(bot, conversationId, content).catch(() => {});
  if (room) void runRoom(room, message).catch(() => {});
  return message;
}

/** A direct message. The Chief of Staff plans real work with the whole team; everyone else just answers. */
async function directMessage(bot: Bot, conversationId: ConversationId, content: string) {
  if (bot.role === "chief") {
    const active = activePlanIn(conversationId);
    if (active) return void (await amendPlan(active.id, content));
    const last = await lastPlanIn(conversationId);
    if (last?.status === "interrupted" && /^\s*(resume|continue)\b/i.test(content)) return void (await resumePlan(last.id));
    if (await startPlan({ conversationId, instruction: content, chief: bot })) return;
  }
  await runTurn({ bot, conversationId, content });
}

/** Stop everything in a conversation: running replies and any plan. */
export async function stopEverything(conversationId: ConversationId): Promise<void> {
  const active = activePlanIn(conversationId);
  if (active) await cancelPlan(active.id, "Stopped by you.");
  await stopConversation(conversationId);
}

export async function clearConversation(conversationId: ConversationId): Promise<void> {
  parseConversation(conversationId);
  await stopEverything(conversationId);
  await store.clearMessages(conversationId);
  await store.bumpGeneration(conversationId);
  forgetConversation(conversationId);
}

export async function summaries(): Promise<ConversationSummary[]> {
  const [bots, rooms, last, unread] = await Promise.all([store.listBots(), store.listRooms(), store.lastMessages(), store.unreadCounts()]);
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const ids = [...bots.map((b) => `dm:${b.id}`), ...rooms.map((r) => roomConversationId(r.id))];
  return ids.map((id) => {
    const m = last.get(id);
    return {
      id,
      running: runningBots(id),
      unread: unread.get(id) ?? 0,
      lastMessage: m
        ? {
            text: messagePreview(m),
            createdAt: m.createdAt,
            author: m.role === "user" ? "You" : (names.get(m.botId ?? "") ?? "Bot"),
          }
        : undefined,
    };
  });
}
