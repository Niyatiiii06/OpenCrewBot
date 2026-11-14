// App storage: bots, rooms, and the chat transcript the UI shows. Mastra keeps
// its own store (mastra.db) for each bot's model-facing thread history.
import { createClient, type Client } from "@libsql/client";
import { APP_DB_URL } from "./config";
import type {
  Approval,
  Artifact,
  AuditEntry,
  Bot,
  ChatMessage,
  ConversationId,
  MemoryLogEntry,
  Plan,
  Room,
  UsageRow,
  UsageSummary,
  Workflow,
  WorkflowRun,
} from "@/lib/shared/types";

// Cached across hot reloads, together with the file it points at, so a
// changed database path opens a fresh connection instead of reusing one
// bound to a file that has moved.
const g = globalThis as unknown as { __opencrewbotDb?: { url: string; schema?: number; client: Promise<Client> } };

/** Bump when a table is added, so a hot-reloaded server re-runs the CREATE statements. */
const SCHEMA_VERSION = 3;

async function open(): Promise<Client> {
  const db = createClient({ url: APP_DB_URL });
  await db.batch(
    [
      "CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, created_at)",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        last_read_at TEXT
      )`,
      // OpenCrewBot 2.0: plans (with their tasks), approvals, audit trail, model usage,
      // scheduled workflows, memory provenance and saved deliverables.
      "CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS plans_by_created ON plans (created_at)",
      "CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS audit_by_at ON audit (at)",
      `CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, bot_id TEXT, model TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL, plan_id TEXT, purpose TEXT
      )`,
      "CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS memory_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)",
    ],
    "write",
  );
  return db;
}

export function db(): Promise<Client> {
  const cached = g.__opencrewbotDb;
  if (cached?.url === APP_DB_URL && cached.schema === SCHEMA_VERSION) return cached.client;
  // Close the old connection (an older build cached the bare promise).
  const stale = cached && "client" in cached ? cached.client : (cached as unknown as Promise<Client> | undefined);
  void stale?.then((c) => c.close()).catch(() => {});
  const client = open();
  g.__opencrewbotDb = { url: APP_DB_URL, schema: SCHEMA_VERSION, client };
  return client;
}

// ── settings (small JSON values) ────────────────────────────────────────

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM settings WHERE key = ?", args: [key] });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as T) : undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
    args: [key, JSON.stringify(value)],
  });
}

// ── bots ────────────────────────────────────────────────────────────────

/** Fill in fields added after a bot was saved, so older rows keep working. */
export function normalizeBot(raw: Bot): Bot {
  return {
    ...raw,
    connections: raw.connections ?? [],
    role: raw.role ?? "member",
    skills: raw.skills ?? [],
    outputFormat: raw.outputFormat ?? "",
    modelMode: raw.modelMode ?? "fixed",
    fallbackModels: raw.fallbackModels ?? [],
    toolPolicy: raw.toolPolicy ?? {},
    limits: { ...{ maxActionsPerRun: 3, allowedEmailDomains: [], allowedRepos: [] }, ...(raw.limits ?? {}) },
    createdBy: raw.createdBy ?? "seed",
  };
}

export async function listBots(): Promise<Bot[]> {
  const rows = await (await db()).execute("SELECT data FROM bots");
  return rows.rows
    .map((r) => normalizeBot(JSON.parse(String(r.data)) as Bot))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getBot(id: string): Promise<Bot | null> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM bots WHERE id = ?", args: [id] });
  return rows.rows[0] ? normalizeBot(JSON.parse(String(rows.rows[0].data)) as Bot) : null;
}

export async function saveBot(bot: Bot): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO bots (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    args: [bot.id, JSON.stringify(bot)],
  });
}

export async function deleteBotRow(id: string): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM bots WHERE id = ?", args: [id] });
}

// ── rooms ───────────────────────────────────────────────────────────────

export async function listRooms(): Promise<Room[]> {
  const rows = await (await db()).execute("SELECT data FROM rooms");
  return rows.rows
    .map((r) => JSON.parse(String(r.data)) as Room)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getRoom(id: string): Promise<Room | null> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM rooms WHERE id = ?", args: [id] });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as Room) : null;
}

export async function saveRoom(room: Room): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO rooms (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    args: [room.id, JSON.stringify(room)],
  });
}

export async function deleteRoomRow(id: string): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM rooms WHERE id = ?", args: [id] });
}

// ── messages ────────────────────────────────────────────────────────────

export async function saveMessage(message: ChatMessage): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO messages (id, conversation_id, created_at, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    args: [message.id, message.conversationId, message.createdAt, JSON.stringify(message)],
  });
}

export async function listMessages(conversationId: ConversationId, limit = 200): Promise<ChatMessage[]> {
  const rows = await (await db()).execute({
    sql: `SELECT data FROM (
            SELECT data, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
          ) ORDER BY created_at ASC`,
    args: [conversationId, limit],
  });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as ChatMessage);
}

export async function clearMessages(conversationId: ConversationId): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM messages WHERE conversation_id = ?", args: [conversationId] });
}

/** The newest message per conversation, for sidebar previews. */
export async function lastMessages(): Promise<Map<ConversationId, ChatMessage>> {
  const rows = await (await db()).execute(
    `SELECT m.data FROM messages m
     JOIN (SELECT conversation_id, MAX(created_at) AS latest FROM messages GROUP BY conversation_id) l
       ON m.conversation_id = l.conversation_id AND m.created_at = l.latest`,
  );
  const out = new Map<ConversationId, ChatMessage>();
  for (const r of rows.rows) {
    const m = JSON.parse(String(r.data)) as ChatMessage;
    out.set(m.conversationId, m);
  }
  return out;
}

export async function unreadCounts(): Promise<Map<ConversationId, number>> {
  const rows = await (await db()).execute(
    `SELECT m.conversation_id AS id, COUNT(*) AS n FROM messages m
     LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE m.created_at > COALESCE(c.last_read_at, '') AND m.data NOT LIKE '%"role":"user"%'
     GROUP BY m.conversation_id`,
  );
  return new Map(rows.rows.map((r) => [String(r.id), Number(r.n)]));
}

export async function markRead(conversationId: ConversationId): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO conversations (id, last_read_at) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    args: [conversationId, new Date().toISOString()],
  });
}

/** Bumped by "Clear chat" so each bot starts a fresh model-side thread. */
export async function conversationGeneration(conversationId: ConversationId): Promise<number> {
  const rows = await (await db()).execute({
    sql: "SELECT generation FROM conversations WHERE id = ?",
    args: [conversationId],
  });
  return rows.rows[0] ? Number(rows.rows[0].generation) : 0;
}

export async function bumpGeneration(conversationId: ConversationId): Promise<number> {
  await (await db()).execute({
    sql: `INSERT INTO conversations (id, generation) VALUES (?, 1)
          ON CONFLICT(id) DO UPDATE SET generation = generation + 1`,
    args: [conversationId],
  });
  return conversationGeneration(conversationId);
}

// ── generic helpers for the JSON-in-a-column tables ─────────────────────

async function putJson(table: string, columns: Record<string, string | number | null>, data: unknown): Promise<void> {
  const names = [...Object.keys(columns), "data"];
  const updates = names.filter((n) => n !== "id").map((n) => `${n} = excluded.${n}`);
  await (await db()).execute({
    sql: `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
          ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
    args: [...Object.values(columns), JSON.stringify(data)],
  });
}

async function allJson<T>(sql: string, args: Array<string | number> = []): Promise<T[]> {
  const rows = await (await db()).execute({ sql, args });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as T);
}

// ── plans ───────────────────────────────────────────────────────────────

export async function savePlan(plan: Plan): Promise<void> {
  await putJson("plans", { id: plan.id, conversation_id: plan.conversationId, status: plan.status, created_at: plan.createdAt }, plan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  return (await allJson<Plan>("SELECT data FROM plans WHERE id = ?", [id]))[0] ?? null;
}

export async function listPlans(limit = 100): Promise<Plan[]> {
  return allJson<Plan>("SELECT data FROM plans ORDER BY created_at DESC LIMIT ?", [limit]);
}

export async function plansWithStatus(statuses: string[]): Promise<Plan[]> {
  return allJson<Plan>(`SELECT data FROM plans WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at`, statuses);
}

// ── approvals and the audit trail ───────────────────────────────────────

export async function saveApproval(approval: Approval): Promise<void> {
  await putJson("approvals", { id: approval.id, status: approval.status, created_at: approval.createdAt }, approval);
}

export async function getApproval(id: string): Promise<Approval | null> {
  return (await allJson<Approval>("SELECT data FROM approvals WHERE id = ?", [id]))[0] ?? null;
}

export async function listApprovals(limit = 200): Promise<Approval[]> {
  return allJson<Approval>("SELECT data FROM approvals ORDER BY created_at DESC LIMIT ?", [limit]);
}

export async function pendingApprovals(): Promise<Approval[]> {
  return allJson<Approval>("SELECT data FROM approvals WHERE status = 'pending' ORDER BY created_at");
}

export async function addAudit(entry: AuditEntry): Promise<void> {
  await putJson("audit", { id: entry.id, at: entry.at }, entry);
}

export async function listAudit(limit = 300): Promise<AuditEntry[]> {
  return allJson<AuditEntry>("SELECT data FROM audit ORDER BY at DESC LIMIT ?", [limit]);
}

// ── model usage ─────────────────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  at: string;
  botId?: string;
  model: string;
  input: number;
  output: number;
  costUsd: number;
  planId?: string;
  purpose: string;
}

export async function addUsage(u: UsageRecord): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO usage (id, at, bot_id, model, input, output, cost, plan_id, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [u.id, u.at, u.botId ?? null, u.model, u.input, u.output, u.costUsd, u.planId ?? null, u.purpose],
  });
}

export async function usageSummary(): Promise<UsageSummary> {
  const client = await db();
  const group = async (expr: string, order = "cost DESC"): Promise<UsageRow[]> => {
    const rows = await client.execute(
      `SELECT ${expr} AS key, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost FROM usage GROUP BY ${expr} ORDER BY ${order} LIMIT 60`,
    );
    return rows.rows.map((r) => ({
      key: String(r.key ?? "none"),
      calls: Number(r.calls),
      input: Number(r.input ?? 0),
      output: Number(r.output ?? 0),
      costUsd: Number(r.cost ?? 0),
    }));
  };
  const total = (await client.execute("SELECT COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost FROM usage")).rows[0];
  return {
    total: { key: "total", calls: Number(total.calls), input: Number(total.input ?? 0), output: Number(total.output ?? 0), costUsd: Number(total.cost ?? 0) },
    byModel: await group("model"),
    byBot: await group("COALESCE(bot_id, 'chief-of-staff planning')"),
    byDay: await group("substr(at, 1, 10)", "key DESC"),
  };
}

// ── workflows ───────────────────────────────────────────────────────────

export async function saveWorkflow(w: Workflow): Promise<void> {
  await putJson("workflows", { id: w.id }, w);
}

export async function listWorkflows(): Promise<Workflow[]> {
  return (await allJson<Workflow>("SELECT data FROM workflows")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  return (await allJson<Workflow>("SELECT data FROM workflows WHERE id = ?", [id]))[0] ?? null;
}

export async function deleteWorkflowRow(id: string): Promise<void> {
  const client = await db();
  await client.execute({ sql: "DELETE FROM workflows WHERE id = ?", args: [id] });
  await client.execute({ sql: "DELETE FROM workflow_runs WHERE workflow_id = ?", args: [id] });
}

export async function saveWorkflowRun(run: WorkflowRun): Promise<void> {
  await putJson("workflow_runs", { id: run.id, workflow_id: run.workflowId, started_at: run.startedAt }, run);
}

export async function listWorkflowRuns(workflowId?: string, limit = 100): Promise<WorkflowRun[]> {
  return workflowId
    ? allJson<WorkflowRun>("SELECT data FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?", [workflowId, limit])
    : allJson<WorkflowRun>("SELECT data FROM workflow_runs ORDER BY started_at DESC LIMIT ?", [limit]);
}

// ── memory provenance ───────────────────────────────────────────────────

export async function addMemoryLog(entry: MemoryLogEntry): Promise<void> {
  await putJson("memory_log", { id: entry.id, at: entry.at, scope: entry.scope }, entry);
}

export async function listMemoryLog(scope?: string, limit = 200): Promise<MemoryLogEntry[]> {
  return scope
    ? allJson<MemoryLogEntry>("SELECT data FROM memory_log WHERE scope = ? ORDER BY at DESC LIMIT ?", [scope, limit])
    : allJson<MemoryLogEntry>("SELECT data FROM memory_log ORDER BY at DESC LIMIT ?", [limit]);
}

// ── saved deliverables ──────────────────────────────────────────────────

export async function saveArtifactRow(a: Artifact): Promise<void> {
  await putJson("artifacts", { id: a.id, created_at: a.createdAt }, a);
}

export async function getArtifactRow(id: string): Promise<Artifact | null> {
  return (await allJson<Artifact>("SELECT data FROM artifacts WHERE id = ?", [id]))[0] ?? null;
}

export async function listArtifacts(limit = 200): Promise<Artifact[]> {
  return allJson<Artifact>("SELECT data FROM artifacts ORDER BY created_at DESC LIMIT ?", [limit]);
}
