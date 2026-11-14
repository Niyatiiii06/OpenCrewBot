// Each bot's memory is one Markdown file: data/workspaces/<botId>/MEMORY.md.
// You can open and edit it in any editor; the bot reads it at the start of
// every turn and changes it through two small tools.
//
// OpenCrewBot 2.0 adds shared scopes next to it, all plain Markdown you can edit:
//   data/memory/USER.md        how you like work done (every agent reads it)
//   data/memory/PROJECT.md     facts about the business and ongoing projects
//   data/memory/DECISIONS.md   decisions that were made, and why
//   data/memory/HISTORY.md     one line per finished plan (written by the engine)
//   data/memory/rooms/<id>.md  findings agents share inside one room
// Every write records its provenance: what was saved, when, by whom and why.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, MemoryLogEntry, MemoryScope, MemoryScopeKind, Room } from "@/lib/shared/types";
import { MEMORY_DIR, WORKSPACES_DIR } from "./config";
import { addMemoryLog } from "./db";
import { publish } from "./bus";

/** How much of MEMORY.md goes into the prompt. The file itself can be longer. */
export const MEMORY_PROMPT_LIMIT = { lines: 200, bytes: 16 * 1024 };

export function workspaceDir(botId: string): string {
  const dir = join(WORKSPACES_DIR, botId.replace(/[^a-zA-Z0-9_-]/g, ""));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryPath(botId: string): string {
  return join(workspaceDir(botId), "MEMORY.md");
}

export function readMemory(botId: string): string {
  const path = memoryPath(botId);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|tvly|ak|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
];

/** Bots sometimes "helpfully" remember a key they saw. They don't get to keep it. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => `«redacted ${m.length} chars»`);
  }
  return out;
}

export function writeMemory(botId: string, content: string): string {
  const path = memoryPath(botId);
  const clean = redactSecrets(content);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, path);
  return clean;
}

export function deleteWorkspace(botId: string): void {
  rmSync(workspaceDir(botId), { recursive: true, force: true });
}

/** The slice of MEMORY.md that loads into the prompt, and whether it was cut. */
export function memoryForPrompt(botId: string): { text: string; truncated: boolean } {
  const full = readMemory(botId);
  let text = full.split("\n").slice(0, MEMORY_PROMPT_LIMIT.lines).join("\n");
  if (Buffer.byteLength(text) > MEMORY_PROMPT_LIMIT.bytes) {
    text = Buffer.from(text).subarray(0, MEMORY_PROMPT_LIMIT.bytes).toString("utf8");
  }
  return { text: text.trim(), truncated: text.length < full.trimEnd().length };
}

export function appendMemory(botId: string, note: string, section?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const line = `- ${note.trim().replace(/\n+/g, " ")} _(${today})_`;
  let content = readMemory(botId).trimEnd();
  if (section) {
    const heading = `## ${section.trim()}`;
    const idx = content.split("\n").findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
    if (idx >= 0) {
      const lines = content.split("\n");
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      while (end > idx + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, line);
      content = lines.join("\n");
    } else {
      content = `${content}${content ? "\n\n" : ""}${heading}\n${line}`;
    }
  } else {
    const afterHeading = /(^|\n)#[^\n]*$/.test(content);
    content = `${content}${content ? (afterHeading ? "\n\n" : "\n") : ""}${line}`;
  }
  return writeMemory(botId, `${content}\n`);
}

export function editMemory(botId: string, find: string, replace: string): { ok: boolean; reason?: string } {
  const content = readMemory(botId);
  const count = content.split(find).length - 1;
  if (!find || count === 0) return { ok: false, reason: "That exact text isn't in MEMORY.md. Read it again and copy the text exactly." };
  if (count > 1) return { ok: false, reason: `That text appears ${count} times. Include more surrounding words so it matches once.` };
  writeMemory(botId, content.replace(find, replace));
  return { ok: true };
}

// ── scopes ──────────────────────────────────────────────────────────────

const SHARED: Record<string, { file: string; title: string; description: string; seed: string }> = {
  user: {
    file: "USER.md",
    title: "Your preferences",
    description: "How you like work done. Every agent reads this on every turn.",
    seed: "# User preferences\n\nHow the person likes work done. Every agent reads this file on every turn.\n",
  },
  project: {
    file: "PROJECT.md",
    title: "Project memory",
    description: "Facts about the business and ongoing projects, shared by every agent.",
    seed:
      "# Project memory\n\nFacts about the business and ongoing work, shared by every agent.\n\n## The business\n" +
      "- The example business is MeetUniversity (https://www.meetuniversity.com/). _(from the project brief)_\n" +
      "- Product lines: Aspirations (student career discovery and navigation), Study Abroad / University Applications, and School Partnerships. _(from the project brief)_\n",
  },
  decisions: {
    file: "DECISIONS.md",
    title: "Decisions",
    description: "Important decisions and why they were made.",
    seed: "# Decisions\n\nImportant decisions and why they were made.\n",
  },
  history: {
    file: "HISTORY.md",
    title: "Work history",
    description: "One entry per finished plan, written by the execution engine.",
    seed: "# Work history\n\nOne entry per finished plan, newest last. Agents read the latest entries for context.\n",
  },
};

export function scopeKind(scope: string): MemoryScopeKind {
  if (scope.startsWith("agent:")) return "agent";
  if (scope.startsWith("room:")) return "room";
  if (scope in SHARED) return scope as MemoryScopeKind;
  throw new Error(`Unknown memory scope "${scope}".`);
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "");

export function scopePath(scope: string): string {
  const kind = scopeKind(scope);
  if (kind === "agent") return memoryPath(scope.slice("agent:".length));
  if (kind === "room") return join(MEMORY_DIR, "rooms", `${safeId(scope.slice("room:".length))}.md`);
  return join(/*turbopackIgnore: true*/ MEMORY_DIR, SHARED[scope].file);
}

function seedFor(scope: string, title?: string): string {
  const kind = scopeKind(scope);
  if (kind === "room") return `# ${title ?? "Room"} room memory\n\nFindings, working notes and intermediate results agents share in this room.\n`;
  if (kind === "agent") return `# ${title ?? "Bot"}'s memory\n\n`;
  return SHARED[scope].seed;
}

export function readScope(scope: string, title?: string): string {
  const path = scopePath(scope);
  if (!existsSync(/*turbopackIgnore: true*/ path)) {
    if (scopeKind(scope) === "agent") return "";
    writeFileSync(path, seedFor(scope, title), { mode: 0o600 });
  }
  return readFileSync(/*turbopackIgnore: true*/ path, "utf8");
}

export interface Provenance {
  /** Who wrote it: a bot's name, "You" or "System". */
  by: string;
  /** Why it is worth remembering. */
  why: string;
  /** Where it came from: a conversation id, a task, or "memory editor". */
  source: string;
}

function log(scope: string, action: MemoryLogEntry["action"], text: string, p: Provenance): void {
  const entry: MemoryLogEntry = { id: randomUUID(), at: new Date().toISOString(), scope, action, text: redactSecrets(text).slice(0, 2000), ...p };
  void addMemoryLog(entry).catch(() => {});
  publish({ type: "memory-scope-changed", scope });
  if (scope.startsWith("agent:")) publish({ type: "memory-changed", botId: scope.slice("agent:".length) });
}

/** Replace a whole memory file (the memory editor does this). */
export function writeScope(scope: string, content: string, p: Provenance, action: MemoryLogEntry["action"] = "user-edit"): string {
  const path = scopePath(scope);
  const before = existsSync(/*turbopackIgnore: true*/ path) ? readFileSync(/*turbopackIgnore: true*/ path, "utf8") : "";
  const clean = redactSecrets(content);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, path);
  if (clean !== before) log(scope, action, summarizeEdit(before, clean), p);
  return clean;
}

/** A short description of what an edit changed, for the provenance log. */
function summarizeEdit(before: string, after: string): string {
  const old = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
  const now = new Set(after.split("\n").map((l) => l.trim()).filter(Boolean));
  const added = [...now].filter((l) => !old.has(l));
  const removed = [...old].filter((l) => !now.has(l));
  const parts: string[] = [];
  if (added.length) parts.push(`Added: ${added.slice(0, 4).join(" | ")}`);
  if (removed.length) parts.push(`Removed: ${removed.slice(0, 4).join(" | ")}`);
  return parts.join("  ·  ") || "Whitespace change";
}

/** Add one line to a scope. The line carries its own provenance so the file explains itself. */
export function appendScope(scope: string, note: string, p: Provenance, section?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const text = note.trim().replace(/\n+/g, " ");
  const why = p.why.trim().replace(/\n+/g, " ");
  const line = `- ${text} _(${today}, by ${p.by}${why ? `: ${why}` : ""})_`;
  let content = readScope(scope).trimEnd();
  if (section) {
    const heading = `## ${section.trim()}`;
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
    if (idx >= 0) {
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      while (end > idx + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, line);
      content = lines.join("\n");
    } else {
      content = `${content}${content ? "\n\n" : ""}${heading}\n${line}`;
    }
  } else {
    content = `${content}${content ? "\n" : ""}${line}`;
  }
  const path = scopePath(scope);
  const clean = redactSecrets(`${content}\n`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, path);
  log(scope, "add", text, p);
  return clean;
}

export function editScope(scope: string, find: string, replace: string, p: Provenance): { ok: boolean; reason?: string } {
  const content = readScope(scope);
  const count = find ? content.split(find).length - 1 : 0;
  if (count === 0) return { ok: false, reason: "That exact text isn't in the memory file. Read it again and copy the text exactly." };
  if (count > 1) return { ok: false, reason: `That text appears ${count} times. Include more surrounding words so it matches once.` };
  const path = scopePath(scope);
  writeFileSync(path, redactSecrets(content.replace(find, replace)), { mode: 0o600 });
  log(scope, "edit", `"${find.slice(0, 200)}" → "${replace.slice(0, 200)}"`, p);
  return { ok: true };
}

export function deleteRoomMemory(roomId: string): void {
  rmSync(scopePath(`room:${roomId}`), { force: true });
}

/** Every memory file, for the Memory manager. */
export function listScopes(bots: Bot[], rooms: Room[]): MemoryScope[] {
  const info = (id: string, kind: MemoryScopeKind, title: string, description: string): MemoryScope => {
    readScope(id, title);
    const path = scopePath(id);
    const stat = existsSync(/*turbopackIgnore: true*/ path) ? statSync(/*turbopackIgnore: true*/ path) : null;
    return { id, kind, title, description, path, bytes: stat?.size ?? 0, updatedAt: stat ? stat.mtime.toISOString() : null };
  };
  return [
    ...Object.entries(SHARED).map(([id, s]) => info(id, id as MemoryScopeKind, s.title, s.description)),
    ...rooms.map((r) => info(`room:${r.id}`, "room", `${r.name} room`, "Findings and working notes shared by agents in this room.")),
    ...bots.map((b) => info(`agent:${b.id}`, "agent", `${b.name}`, `${b.name}'s own notes. Only ${b.name} reads this file.`)),
  ];
}

function clip(text: string, lines: number, bytes: number, fromEnd = false): string {
  const all = text.split("\n");
  let out = (fromEnd ? all.slice(-lines) : all.slice(0, lines)).join("\n");
  if (Buffer.byteLength(out) > bytes) out = Buffer.from(out).subarray(0, bytes).toString("utf8");
  return out.trim();
}

/** The shared memory an agent sees on every turn: your preferences, the project,
 * decisions, recent work, and the room it is working in. Read fresh from disk each
 * time, so an edit to any file applies to the very next reply. */
export function sharedMemoryForPrompt(roomId?: string, roomName?: string): string {
  const sections: string[] = [];
  const add = (heading: string, scope: string, lines: number, fromEnd = false, title?: string) => {
    const text = clip(readScope(scope, title), lines, 6 * 1024, fromEnd);
    // Skip files that still hold only their heading and description.
    if (text.split("\n").filter((l) => l.trim().startsWith("-") || l.trim().startsWith("|")).length === 0) return;
    sections.push(`### ${heading}\n${text}`);
  };
  add("The person's preferences (USER.md). Follow these.", "user", 60);
  add("Project memory (PROJECT.md)", "project", 80);
  add("Decisions (DECISIONS.md). Treat these as settled unless the person changes them.", "decisions", 40, true);
  if (roomId) add(`Room memory for "${roomName ?? "this room"}"`, `room:${roomId}`, 60, true, roomName);
  add("Recent work (HISTORY.md)", "history", 12, true);
  return sections.join("\n\n");
}
