// Agent-to-agent collaboration: ask, verify, challenge, delegate, share.
// Guards keep agents from looping: nobody talks to themselves, a chain of
// questions stops at two levels, two agents can never wait on each other, each
// plan has a message budget, and every question has a time limit.
import type { Bot } from "@/lib/shared/types";
import { getBot, getRoom, listBots } from "./db";
import { addDelegatedTask, noteOnPlan, spendTeammateMessage } from "./engine";
import { appendScope } from "./memory-files";
import { audit } from "./permissions";
import { runTurn } from "./runtime";
import type { TurnContext } from "./turns";

type Mode = "ask" | "verify" | "challenge" | "delegate";

const MAX_DEPTH = 2;
const ANSWER_TIMEOUT_MS = 150_000;
const MAX_PER_TURN = 4;

interface CollabState {
  /** `${conversationId}|${botId}` → who that agent is waiting for, and how deep the chain is */
  waiting: Map<string, { on: string; depth: number }>;
  /** `${conversationId}|${botId}` → questions asked during the current turn */
  asked: WeakMap<TurnContext, number>;
}

const g = globalThis as unknown as { __opencrewbotCollab?: CollabState };
const state = (g.__opencrewbotCollab ??= { waiting: new Map(), asked: new WeakMap() });

const key = (conversationId: string, botId: string) => `${conversationId}|${botId}`;

async function teammates(conversationId: string): Promise<Bot[]> {
  const all = await listBots();
  if (!conversationId.startsWith("room:")) return all;
  const room = await getRoom(conversationId.slice(5));
  return room ? all.filter((b) => room.memberIds.includes(b.id)) : all;
}

function findTeammate(team: Bot[], name: string): Bot | undefined {
  const wanted = name.trim().replace(/^@/, "").toLowerCase();
  return team.find((b) => b.handle === wanted || b.name.toLowerCase() === wanted) ?? team.find((b) => wanted && (b.name.toLowerCase().includes(wanted) || b.title.toLowerCase().includes(wanted)));
}

const refuse = (reason: string) => ({ ok: false, answered: false, message: `NOT SENT: ${reason}. Continue with what you have.` });

const FRAMES: Record<Mode, (from: string, body: string) => string> = {
  ask: (from, body) => `[Question from your teammate ${from}]\n\n${body}\n\nAnswer the question directly and briefly. Use your tools if you need to check a fact. Do not ask ${from} anything back.`,
  verify: (from, body) => `[Verification request from your teammate ${from}]\n\n${body}\n\nCheck this against sources or data you can reach. Start your reply with VERIFIED or NEEDS CHANGES, then list each problem with the evidence. If you cannot check something, say so; do not guess.`,
  challenge: (from, body) => `[Challenge from your teammate ${from}]\n\n${body}\n\nEither defend the conclusion with specific evidence, or revise it. Start your reply with DEFENDED or REVISED.`,
  delegate: (from, body) => `[Work handed to you by your teammate ${from}]\n\n${body}\n\nDo this and reply with the complete result.`,
};

export async function askTeammate(turn: TurnContext, fromId: string, to: string, body: string, mode: Mode) {
  const from = await getBot(fromId);
  if (!from) return refuse("the asking agent no longer exists");
  const team = await teammates(turn.conversationId);
  // A verification with no name goes to the room's reviewer.
  const target = to.trim() ? findTeammate(team, to) : team.find((b) => b.id !== fromId && /review|qa\b|verif|quality/i.test(b.title));
  if (!target) return refuse(to.trim() ? `nobody here is called "${to}". Teammates: ${team.filter((b) => b.id !== fromId).map((b) => `@${b.handle}`).join(", ")}` : "there is no reviewer in this room");
  if (target.id === fromId) return refuse("you cannot ask yourself");

  const me = key(turn.conversationId, fromId);
  const them = key(turn.conversationId, target.id);
  const depth = (state.waiting.get(me)?.depth ?? 0) + 1;
  // Find who is (indirectly) waiting on me. Asking any of them would deadlock.
  let cursor = state.waiting.get(them);
  for (let hops = 0; cursor && hops < 8; hops++) {
    if (cursor.on === me) return refuse(`${target.name} is already waiting for an answer from you, so asking them now would deadlock`);
    cursor = state.waiting.get(cursor.on);
  }
  for (const [asker, w] of state.waiting) if (w.on === me && asker === them) return refuse(`${target.name} asked you this; answer them instead of asking back`);
  const incoming = [...state.waiting.values()].find((w) => w.on === me);
  const chain = (incoming?.depth ?? 0) + 1;
  if (chain > MAX_DEPTH || depth > MAX_DEPTH) return refuse(`question chains stop at ${MAX_DEPTH} levels, to prevent loops`);
  const count = state.asked.get(turn) ?? 0;
  if (count >= MAX_PER_TURN) return refuse(`you have already contacted teammates ${MAX_PER_TURN} times in this turn`);
  if (!spendTeammateMessage(turn.planId)) return refuse("this plan has used its budget of agent-to-agent messages");
  state.asked.set(turn, count + 1);

  state.waiting.set(me, { on: them, depth: chain });
  noteOnPlan(turn.planId, mode, `${from.name} → ${target.name}: ${mode === "ask" ? "question" : mode}.`, turn.taskId);
  await audit({ event: `teammate-${mode}`, botId: from.id, botName: from.name, detail: `${from.name} → ${target.name}: ${body.slice(0, 160)}`, conversationId: turn.conversationId, planId: turn.planId, taskId: turn.taskId });
  try {
    const reply = await Promise.race([
      runTurn({ bot: target, conversationId: turn.conversationId, content: FRAMES[mode](from.name, body), route: { by: "teammate", planId: turn.planId, taskId: turn.taskId }, context: { planId: turn.planId, taskId: turn.taskId }, tier: mode === "ask" ? "fast" : "balanced" }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ANSWER_TIMEOUT_MS)),
      new Promise<"stopped">((r) => turn.signal?.addEventListener("abort", () => r("stopped"), { once: true })),
    ]);
    if (reply === "timeout") return { ok: false, answered: false, message: `${target.name} did not answer within ${ANSWER_TIMEOUT_MS / 1000} seconds. Continue without it and say so.` };
    if (reply === "stopped" || !reply) return { ok: false, answered: false, message: "The run was stopped." };
    const answer = reply.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n").trim();
    if (reply.status !== "done" || !answer) return { ok: false, answered: false, message: `${target.name} could not answer (${reply.error ?? reply.status}). Continue without it and say so.` };
    return { ok: true, answered: true, from: target.name, answer };
  } finally {
    state.waiting.delete(me);
  }
}

export async function delegate(turn: TurnContext, fromId: string, to: string, task: string, reason: string) {
  const from = await getBot(fromId);
  if (!from) return refuse("the delegating agent no longer exists");
  const team = await teammates(turn.conversationId);
  const target = findTeammate(team, to);
  if (!target) return refuse(`nobody here is called "${to}". Teammates: ${team.filter((b) => b.id !== fromId).map((b) => `@${b.handle}`).join(", ")}`);
  // Outside a plan there is no task board: the teammate does it now and the result comes straight back.
  if (!turn.planId) return askTeammate(turn, fromId, to, task, "delegate");
  const result = await addDelegatedTask(turn.planId, turn.taskId, from, target, task, reason);
  if (!result.ok) return refuse(result.reason ?? "the delegation was refused");
  await audit({ event: "delegated", botId: from.id, botName: from.name, detail: `${from.name} delegated ${result.ref} to ${target.name}: ${task.slice(0, 160)}`, conversationId: turn.conversationId, planId: turn.planId, taskId: turn.taskId });
  return { ok: true, delegated: true, task: result.ref, to: target.name, message: `Delegated as ${result.ref} to ${target.name}. It runs on the task board and its result goes into the final answer. Finish your own part now; do not wait for it.` };
}

export async function shareFinding(turn: TurnContext, fromId: string, title: string, content: string, source?: string) {
  const from = await getBot(fromId);
  const scope = turn.conversationId.startsWith("room:") ? turn.conversationId : "project";
  appendScope(scope, `**${title}**: ${content.replace(/\s+/g, " ").slice(0, 600)}${source ? ` (source: ${source})` : ""}`, {
    by: from?.name ?? "An agent",
    why: "shared as a finding for teammates",
    source: turn.taskId ? `task ${turn.taskId} in ${turn.conversationId}` : turn.conversationId,
  }, "Findings");
  noteOnPlan(turn.planId, "finding", `${from?.name ?? "An agent"} shared a finding: ${title}.`, turn.taskId);
  return { ok: true, shared: true, where: scope.startsWith("room:") ? "this room's shared memory" : "project memory" };
}
