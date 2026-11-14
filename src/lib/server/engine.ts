// The execution engine. A plan is a set of tasks with dependencies. The engine
// runs every task whose dependencies are finished (several at once), tracks
// status and timing, retries failures on another model and then another agent,
// enforces timeouts, supports cancellation, takes new instructions mid-run,
// and survives a restart. Every change is saved to SQLite and pushed to the UI.
import { randomUUID } from "node:crypto";
import type { Bot, ChatMessage, ConversationId, Plan, Room, Task, TaskAttempt, TaskStatus } from "@/lib/shared/types";
import { artifactUrl, saveArtifact } from "./artifacts";
import { publish } from "./bus";
import { isMock } from "./config";
import { getBot, getPlan, getRoom, listBots, listPlans, plansWithStatus, savePlan } from "./db";
import { appendScope } from "./memory-files";
import { audit } from "./permissions";
import { makePlan, pickAgent, planAmendment, skillsFor, toolFor, type PlannedTask } from "./planner";
import { tierForTask } from "./providers";
import { markBusy, postBotMessage, postNotice, runTurn, stopTurn } from "./runtime";
import { getSkill, skillBrief } from "./skills";

const MAX_PARALLEL = Number(process.env.OPENCREWBOT_MAX_PARALLEL || 3);
const TASK_TIMEOUT_MS = Number(process.env.OPENCREWBOT_TASK_TIMEOUT_MS || 240_000);
const MAX_ATTEMPTS = 2;
const MAX_DELEGATION_DEPTH = 2;

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE: TaskStatus[] = ["done", "failed", "cancelled", "skipped", "timed-out"];
const BAD: TaskStatus[] = ["failed", "skipped", "timed-out"];
const isOver = (t: Task) => DONE.includes(t.status);

function textOf(message: ChatMessage | null): string {
  if (!message) return "";
  return message.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n").trim();
}

/** Wakes the plan's loop when something changed. A wake-up sent before the loop waits is kept. */
class Signal {
  private dirty = false;
  private waiter: (() => void) | null = null;
  fire() {
    this.dirty = true;
    this.waiter?.();
  }
  async wait() {
    if (!this.dirty) await new Promise<void>((r) => (this.waiter = r));
    this.dirty = false;
    this.waiter = null;
  }
}

interface Runner {
  plan: Plan;
  signal: Signal;
  /** taskId → the agent running it */
  running: Map<string, string>;
  /** Tasks the person cancelled while they were running. */
  cancelled: Set<string>;
  /** Tasks stopped so they run again with new information. */
  restart: Set<string>;
  done: Promise<Plan>;
  finish: (plan: Plan) => void;
}

const g = globalThis as unknown as { __opencrewbotEngine?: Map<string, Runner> };
const runners = (g.__opencrewbotEngine ??= new Map<string, Runner>());

function event(plan: Plan, kind: string, text: string, taskId?: string) {
  plan.events.push({ at: now(), kind, text, taskId });
  if (plan.events.length > 300) plan.events.splice(0, plan.events.length - 300);
}

async function persist(plan: Plan) {
  if (plan.status === "running" || plan.status === "awaiting-approval") {
    plan.status = plan.tasks.some((t) => t.status === "awaiting-approval") ? "awaiting-approval" : "running";
  }
  await savePlan(plan);
  publish({ type: "plan", plan });
}

async function teamFor(plan: Plan): Promise<{ room: Room | null; team: Bot[]; all: Bot[] }> {
  const all = await listBots();
  const room = plan.conversationId.startsWith("room:") ? await getRoom(plan.conversationId.slice(5)) : null;
  const team = room ? all.filter((b) => room.memberIds.includes(b.id)) : all;
  return { room, team, all };
}

// ── building a plan ─────────────────────────────────────────────────────

function newTask(plan: Plan, p: PlannedTask, origin: Task["origin"], extra: Partial<Task> = {}): Task {
  return {
    id: randomUUID().slice(0, 8),
    planId: plan.id,
    ref: p.ref,
    title: p.title,
    description: p.description,
    kind: p.kind,
    agentId: p.agentId,
    dependsOn: [],
    skills: p.skills,
    capability: p.capability,
    status: "pending",
    needsApproval: p.needsApproval,
    attempts: [],
    maxAttempts: MAX_ATTEMPTS,
    timeoutMs: p.kind === "consolidate" ? Math.max(TASK_TIMEOUT_MS, 300_000) : TASK_TIMEOUT_MS,
    createdAt: now(),
    origin,
    depth: 0,
    ...extra,
  };
}

/** Add planned tasks to a plan, turning refs ("T2") into task ids. */
function addTasks(plan: Plan, planned: PlannedTask[], origin: Task["origin"]): Task[] {
  const added = planned.map((p) => newTask(plan, p, origin));
  plan.tasks.push(...added);
  const byRef = new Map(plan.tasks.map((t) => [t.ref, t.id]));
  planned.forEach((p, i) => {
    added[i].dependsOn = p.dependsOn.map((ref) => byRef.get(ref)).filter((id): id is string => Boolean(id) && id !== added[i].id);
  });
  return added;
}

function ensureConsolidation(plan: Plan) {
  const work = plan.tasks.filter((t) => t.kind !== "consolidate" && t.status !== "cancelled");
  if (work.length < 2 || plan.tasks.some((t) => t.kind === "consolidate")) return;
  plan.tasks.push(
    newTask(
      plan,
      { ref: `T${plan.tasks.length + 1}`, title: "Consolidate the final answer", description: "Combine every task result into one deliverable for the person.", agentId: plan.chiefId, dependsOn: [], skills: [], capability: "consolidation", kind: "consolidate", needsApproval: false },
      "plan",
    ),
  );
}

export interface StartOptions {
  conversationId: ConversationId;
  instruction: string;
  chief: Bot;
  workflowId?: string;
}

export function activePlanIn(conversationId: ConversationId): Plan | undefined {
  for (const run of runners.values()) if (run.plan.conversationId === conversationId) return run.plan;
  return undefined;
}

/** Plan an instruction and start running it. Returns null when the Chief should simply answer. */
export async function startPlan(options: StartOptions): Promise<Plan | null> {
  const { conversationId, instruction, chief } = options;
  const all = await listBots();
  const room = conversationId.startsWith("room:") ? await getRoom(conversationId.slice(5)) : null;
  let team = room ? all.filter((b) => room.memberIds.includes(b.id)) : all;

  markBusy(conversationId, chief.id, true);
  let draft;
  try {
    draft = await makePlan(instruction, chief, team, room);
    // Workflows always run as a plan, even for a short instruction.
    if (draft.direct && options.workflowId) {
      const agent = pickAgent(team, { skills: skillsFor(instruction, chief), text: instruction }) ?? chief;
      draft = { ...draft, direct: false, tasks: [{ ref: "T1", title: "Do the work", description: instruction, agentId: agent.id, dependsOn: [], skills: skillsFor(instruction, agent), capability: "general", kind: "work" as const, needsApproval: false }] };
    }
    if (draft.direct) return null;

    // Nobody can do part of the work: borrow an agent from outside the room, or create one.
    const notes = [...draft.notes];
    for (const task of draft.tasks) {
      const tool = toolFor(`${task.capability} ${task.title}`);
      const assigned = team.find((b) => b.id === task.agentId);
      if (assigned && (!tool || assigned.tools[tool])) continue;
      let agent = tool ? team.find((b) => b.tools[tool]) : pickAgent(team, { skills: task.skills, text: task.title });
      if (!agent && tool) {
        agent = all.find((b) => b.tools[tool] && b.role !== "chief");
        if (agent) notes.push(`${agent.name} is not in this room but has the tool for "${task.title}", so they were brought in.`);
      }
      if (!agent) {
        const { createAgentFromDescription } = await import("./factory");
        const description = draft.newAgents.shift() ?? `an agent for ${task.capability}: ${task.title}`;
        agent = await createAgentFromDescription(description, "chief");
        await audit({ event: "agent-created", botId: chief.id, botName: chief.name, detail: `Created ${agent.name} because no agent could do "${task.capability}".`, conversationId });
        notes.push(`Created a new agent, ${agent.name}, for "${task.title}".`);
      }
      if (!team.some((b) => b.id === agent.id)) {
        team = [...team, agent];
        if (room) {
          const { updateRoom } = await import("./service");
          await updateRoom(room.id, { memberIds: [...room.memberIds, agent.id] });
          room.memberIds.push(agent.id);
        }
      }
      task.agentId = agent.id;
    }
    draft.notes = notes;
  } finally {
    markBusy(conversationId, chief.id, false);
  }

  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    conversationId,
    instruction,
    amendments: [],
    goal: draft.goal,
    chiefId: chief.id,
    status: "running",
    tasks: [],
    events: [],
    createdAt: now(),
    startedAt: now(),
    plannedBy: draft.plannedBy,
    model: draft.model,
    simulated: isMock(),
    workflowId: options.workflowId,
    budget: { delegations: 0, teammateMessages: 0, maxDelegations: 4, maxTeammateMessages: 8, maxTasks: 14 },
    usage: { input: 0, output: 0, costUsd: 0 },
  };
  addTasks(plan, draft.tasks, "plan");
  ensureConsolidation(plan);
  const names = [...new Set(plan.tasks.filter((t) => t.kind !== "consolidate").map((t) => team.find((b) => b.id === t.agentId)?.name ?? "?"))];
  event(plan, "planned", `${chief.name} planned ${plan.tasks.length} tasks for ${names.join(", ")} (${draft.plannedBy === "model" ? `model ${draft.model}` : "built-in rule planner"}).`);
  for (const note of draft.notes) event(plan, "note", note);
  await savePlan(plan);

  const parallel = plan.tasks.filter((t) => t.dependsOn.length === 0 && t.kind !== "consolidate").length;
  await postBotMessage(
    conversationId,
    chief.id,
    [
      {
        kind: "text",
        text: [
          `**Plan:** ${plan.goal}`,
          `${plan.tasks.length} tasks for ${names.join(", ")}. ${parallel > 1 ? `${parallel} start in parallel.` : ""}`,
          ...draft.notes.map((n) => `- ${n}`),
          draft.plannedBy === "rules" ? `_Planned by the built-in rule planner${isMock() ? " (mock mode: no model key is set)" : ""}._` : "",
        ].filter(Boolean).join("\n\n"),
      },
      { kind: "plan", planId: plan.id },
    ],
    { by: "chief", planId: plan.id },
    { simulated: isMock() || undefined, model: draft.model },
  );
  launch(plan);
  return plan;
}

function launch(plan: Plan): Runner {
  let finish!: (plan: Plan) => void;
  const done = new Promise<Plan>((r) => (finish = r));
  const run: Runner = { plan, signal: new Signal(), running: new Map(), cancelled: new Set(), restart: new Set(), done, finish };
  runners.set(plan.id, run);
  publish({ type: "plan", plan });
  void drive(run).catch(async (error) => {
    plan.status = "failed";
    event(plan, "error", `The engine stopped: ${error instanceof Error ? error.message : String(error)}`);
    plan.finishedAt = now();
    await savePlan(plan);
    publish({ type: "plan", plan });
    runners.delete(plan.id);
    finish(plan);
  });
  return run;
}

// ── the loop ────────────────────────────────────────────────────────────

/** Decide what happens to tasks whose inputs did not arrive. */
function settleBlocked(plan: Plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const task of plan.tasks) {
    if (task.status !== "pending" || task.kind === "consolidate" || task.dependsOn.length === 0) continue;
    const deps = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t));
    if (!deps.every(isOver)) continue;
    const bad = deps.filter((d) => BAD.includes(d.status));
    // Work continues with partial inputs. Actions on the outside world do not.
    if (bad.length && (bad.length === deps.length || task.needsApproval)) {
      task.status = "skipped";
      task.error = `Skipped because ${bad.map((d) => `${d.ref} ${d.status}`).join(", ")}.`;
      task.finishedAt = now();
      event(plan, "task-skipped", `${task.ref} skipped: ${bad.map((d) => `${d.ref} ${d.status}`).join(", ")}.`, task.id);
    }
  }
}

function readyTasks(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return plan.tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (task.kind === "consolidate") return plan.tasks.every((t) => t.id === task.id || isOver(t));
    return task.dependsOn.every((id) => {
      const dep = byId.get(id);
      return !dep || isOver(dep);
    });
  });
}

async function drive(run: Runner) {
  const plan = run.plan;
  for (;;) {
    if (plan.status === "cancelled") break;
    settleBlocked(plan);
    for (const task of readyTasks(plan)) {
      if (run.running.size >= MAX_PARALLEL) break;
      // One task per agent at a time, so a timeout measures work, not waiting in line.
      if ([...run.running.values()].includes(task.agentId)) continue;
      run.running.set(task.id, task.agentId);
      task.status = "running";
      void runTask(run, task)
        .catch((error) => {
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
          task.finishedAt = now();
        })
        .finally(() => {
          run.running.delete(task.id);
          run.signal.fire();
        });
    }
    await persist(plan);
    const pending = plan.tasks.filter((t) => t.status === "pending");
    if (run.running.size === 0 && pending.length === 0) break;
    if (run.running.size === 0 && readyTasks(plan).length === 0) {
      for (const t of pending) {
        t.status = "skipped";
        t.error = "Its dependencies never finished.";
        t.finishedAt = now();
      }
      continue;
    }
    if (run.running.size === 0) continue;
    await run.signal.wait();
  }
  while (run.running.size) await run.signal.wait();
  await finalize(run);
}

// ── one task ────────────────────────────────────────────────────────────

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(cut; ${text.length - max} more characters)` : text);

function resultBlock(task: Task, bots: Map<string, Bot>, max: number): string {
  const who = bots.get(task.agentId)?.name ?? "an agent";
  if (task.status === "done") return `<result task="${task.ref}" title="${task.title}" agent="${who}" status="done">\n${clip(task.output ?? "", max)}\n</result>`;
  return `<result task="${task.ref}" title="${task.title}" agent="${who}" status="${task.status}">\n${task.error ?? "No result."}\n</result>`;
}

async function taskPrompt(plan: Plan, task: Task, bot: Bot): Promise<string> {
  const all = await listBots();
  const bots = new Map(all.map((b) => [b.id, b]));
  const chief = bots.get(plan.chiefId);
  const consolidate = task.kind === "consolidate";
  const inputs = consolidate ? plan.tasks.filter((t) => t.id !== task.id && t.status !== "cancelled") : plan.tasks.filter((t) => task.dependsOn.includes(t.id) && t.status !== "cancelled");
  const skills = [...new Set([...task.skills, ...skillsFor(`${task.title} ${task.description}`, bot)])].map((id) => getSkill(id)).filter((s) => s !== undefined).slice(0, 3);
  const sections = [
    consolidate ? `[Final consolidation · plan "${plan.goal}"]` : `[Task ${task.ref} · plan "${plan.goal}"]`,
    consolidate
      ? "Every task of the plan has ended. Write the one consolidated deliverable for the person."
      : `${chief?.name ?? "The Chief of Staff"} assigned this task to you. Teammates are working on other tasks at the same time.`,
    `## The person's instruction\n${plan.instruction}`,
    plan.amendments.length ? `## New instructions since the plan started (these win where they differ)\n${plan.amendments.map((a) => `- ${a.text}`).join("\n")}` : "",
    consolidate ? "" : `## Your task: ${task.title}\n${task.description}`,
    inputs.length ? `## Results from ${consolidate ? "all tasks" : "earlier tasks"}\n${inputs.map((t) => resultBlock(t, bots, consolidate ? 7000 : 5000)).join("\n\n")}` : "",
    skills.length ? `## Skills loaded for this task\n${skills.map((s) => skillBrief(s)).join("\n\n")}` : "",
    consolidate
      ? [
          "## What to write",
          "- One deliverable that answers the instruction: a short summary first, then clear sections.",
          "- Use only what the task results contain. Keep their source links and their chart images (the `![...](...)` lines) exactly.",
          "- Follow the person's preferences in shared memory.",
          "- End with a section \"Not completed\" listing anything that failed, was skipped, was rejected or was only simulated. Leave it out if there is nothing.",
        ].join("\n")
      : [
          "## How to answer",
          "- Do only this task. Give the complete result in your reply, in Markdown.",
          "- Use your tools for facts and numbers. Never invent a source, a number or the result of an action.",
          "- If something stopped you (a tool failed, an action was rejected), say exactly what, and give what you do have.",
        ].join("\n"),
  ];
  return sections.filter(Boolean).join("\n\n");
}

async function runTask(run: Runner, task: Task) {
  const plan = run.plan;
  const bot = await getBot(task.agentId);
  if (!bot) {
    task.status = "failed";
    task.error = "The assigned agent no longer exists.";
    task.finishedAt = now();
    event(plan, "task-failed", `${task.ref} failed: its agent was deleted.`, task.id);
    return;
  }
  const attempt: TaskAttempt = { n: task.attempts.length + 1, startedAt: now(), status: "running" };
  if (attempt.n > 1) await sleep(1500 * (attempt.n - 1));
  task.attempts.push(attempt);
  task.startedAt ??= attempt.startedAt;
  task.error = undefined;
  event(plan, "task-started", `${task.ref} "${task.title}" started by ${bot.name}${attempt.n > 1 ? ` (attempt ${attempt.n})` : ""}.`, task.id);
  await persist(plan);

  // The clock stops while the task waits for the person's approval.
  let timedOut = false;
  let remaining = task.timeoutMs;
  let armedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      void stopTurn(plan.conversationId, bot.id);
    }, remaining);
  };
  const pause = () => {
    clearTimeout(timer);
    remaining = Math.max(20_000, remaining - (Date.now() - armedAt));
  };
  arm();

  let reply: ChatMessage | null = null;
  let thrown = "";
  try {
    reply = await runTurn({
      bot,
      conversationId: plan.conversationId,
      content: await taskPrompt(plan, task, bot),
      route: { by: "task", planId: plan.id, taskId: task.id },
      context: { planId: plan.id, taskId: task.id },
      tier: tierForTask(`${task.title} ${task.description}`, task.kind),
      avoidModels: task.attempts.filter((a) => a.status !== "done" && a.status !== "running" && a.model).map((a) => a.model as string),
      onWaiting: (waiting) => {
        if (isOver(task)) return;
        if (waiting) pause();
        else arm();
        task.status = waiting ? "awaiting-approval" : "running";
        if (waiting) event(plan, "approval", `${task.ref} is waiting for your approval.`, task.id);
        void persist(plan);
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  clearTimeout(timer);

  const text = textOf(reply);
  attempt.finishedAt = now();
  attempt.model = reply?.model;
  task.model = reply?.model;
  task.messageId = reply?.id;
  if (reply?.usage) {
    const u = task.usage ?? { input: 0, output: 0, costUsd: 0 };
    task.usage = { input: u.input + reply.usage.input, output: u.output + reply.usage.output, costUsd: (u.costUsd ?? 0) + (reply.usage.costUsd ?? 0) };
    plan.usage.input += reply.usage.input;
    plan.usage.output += reply.usage.output;
    plan.usage.costUsd += reply.usage.costUsd ?? 0;
  }
  if (reply?.fallbackFrom) event(plan, "model-fallback", `${task.ref}: ${reply.fallbackFrom} failed, ${reply.model} answered.`, task.id);

  if (run.restart.delete(task.id) && plan.status !== "cancelled") {
    attempt.status = "cancelled";
    task.attempts.pop();
    task.status = "pending";
    return;
  }
  if (plan.status === "cancelled" || run.cancelled.has(task.id) || (!timedOut && (!reply || reply.status === "stopped"))) {
    attempt.status = "cancelled";
    task.status = "cancelled";
    task.error = "Cancelled.";
    task.finishedAt = now();
    event(plan, "task-cancelled", `${task.ref} cancelled.`, task.id);
    return;
  }
  if (!timedOut && reply?.status === "done" && text) {
    attempt.status = "done";
    task.status = "done";
    task.output = text;
    task.finishedAt = now();
    const rejected = reply.parts.filter((p) => p.kind === "tool" && p.status === "denied").length;
    event(plan, "task-done", `${task.ref} done by ${bot.name}${rejected ? ` (${rejected} action${rejected > 1 ? "s" : ""} rejected and NOT executed)` : ""}.`, task.id);
    if (task.kind === "review") afterReview(plan, task, text);
    return;
  }

  attempt.status = timedOut ? "timed-out" : "failed";
  attempt.error = timedOut ? `No result after ${Math.round(task.timeoutMs / 1000)} seconds.` : reply?.error || thrown || "The agent returned no answer.";
  task.error = attempt.error;
  event(plan, timedOut ? "task-timeout" : "task-failed", `${task.ref} ${timedOut ? "timed out" : "failed"}: ${attempt.error.slice(0, 200)}`, task.id);

  if (task.attempts.length < task.maxAttempts) {
    task.status = "pending";
    event(plan, "retry", `${task.ref} will be retried (attempt ${task.attempts.length + 1} of ${task.maxAttempts})${attempt.model && attempt.model !== "mock" ? " on a different model" : ""}.`, task.id);
    return;
  }
  // Out of attempts: hand the task to another agent who has the tool, once.
  if (!task.originalAgentId && task.kind !== "consolidate") {
    const { team } = await teamFor(plan);
    const tool = toolFor(`${task.capability} ${task.title}`);
    const candidates = team.filter((b) => b.id !== bot.id && b.role !== "chief" && (!tool || b.tools[tool]));
    const other = pickAgent(candidates, { tool, skills: task.skills, text: `${task.capability} ${task.title}` });
    if (other) {
      task.originalAgentId = bot.id;
      task.agentId = other.id;
      task.maxAttempts += 1;
      task.status = "pending";
      event(plan, "reassigned", `${task.ref} reassigned from ${bot.name} to ${other.name} after ${task.attempts.length} failed attempts.`, task.id);
      return;
    }
  }
  task.status = timedOut ? "timed-out" : "failed";
  task.finishedAt = now();
}

/** A reviewer asked for changes: send the work back to its author once. */
function afterReview(plan: Plan, review: Task, text: string) {
  if (!/^\W*NEEDS CHANGES/i.test(text) || plan.tasks.some((t) => t.origin === "review") || plan.tasks.length >= plan.budget.maxTasks) return;
  const target = plan.tasks.filter((t) => review.dependsOn.includes(t.id) && t.status === "done" && t.kind === "work").pop();
  if (!target) return;
  const revise = newTask(
    plan,
    {
      ref: `T${plan.tasks.length + 1}`,
      title: `Revise: ${target.title}`,
      description: `Your result for "${target.title}" was reviewed and needs changes. Fix every point in the review and give the full corrected result.\n\nThe review:\n${clip(text, 3000)}`,
      agentId: target.agentId,
      dependsOn: [],
      skills: target.skills,
      capability: target.capability,
      kind: "work",
      needsApproval: false,
    },
    "review",
    { dependsOn: [target.id], parentTaskId: review.id },
  );
  // Put the revision before consolidation, and make later actions wait for it.
  const at = plan.tasks.findIndex((t) => t.kind === "consolidate");
  plan.tasks.splice(at < 0 ? plan.tasks.length : at, 0, revise);
  for (const t of plan.tasks) if (t.status === "pending" && t.dependsOn.includes(review.id) && t.id !== revise.id) t.dependsOn.push(revise.id);
  event(plan, "rework", `The review asked for changes, so ${revise.ref} was added for the author to revise ${target.ref}.`, revise.id);
}

// ── finishing ───────────────────────────────────────────────────────────

function stitched(plan: Plan, bots: Map<string, Bot>): string {
  const done = plan.tasks.filter((t) => t.status === "done" && t.kind !== "consolidate");
  const missing = plan.tasks.filter((t) => BAD.includes(t.status) && t.kind !== "consolidate");
  return [
    `# ${plan.goal}`,
    "_The final consolidation step did not finish, so the task results are given as they are._",
    ...done.map((t) => `## ${t.ref} ${t.title} (${bots.get(t.agentId)?.name ?? "agent"})\n\n${t.output}`),
    missing.length ? `## Not completed\n${missing.map((t) => `- ${t.ref} ${t.title}: ${t.status}. ${t.error ?? ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

async function finalize(run: Runner) {
  const plan = run.plan;
  const bots = new Map((await listBots()).map((b) => [b.id, b]));
  const chief = bots.get(plan.chiefId);
  const work = plan.tasks.filter((t) => t.kind !== "consolidate");
  const done = work.filter((t) => t.status === "done");
  const consolidate = plan.tasks.find((t) => t.kind === "consolidate");
  let postedResult = false;

  if (plan.status !== "cancelled") {
    if (consolidate?.status === "done") {
      plan.result = consolidate.output;
      postedResult = true;
    } else if (!consolidate && done.length) {
      plan.result = done[done.length - 1].output;
      postedResult = true;
    } else if (done.length) {
      plan.result = stitched(plan, bots);
    }
    // A report that only says "everything failed" is still a failed plan.
    plan.status = plan.result && done.length ? "done" : "failed";
  }
  plan.finishedAt = now();
  const failed = work.filter((t) => BAD.includes(t.status));
  const summary = `${done.length} of ${work.length} tasks done${failed.length ? `, ${failed.length} not completed (${failed.map((t) => t.ref).join(", ")})` : ""}`;

  if (plan.result) {
    const header = `<!-- Plan ${plan.id} · ${plan.finishedAt} · ${summary}${plan.simulated ? " · MOCK MODE: written by the scripted mock model, tools really ran" : ""} -->\n\n`;
    const artifact = await saveArtifact({ title: plan.goal, content: header + plan.result, kind: "report", botId: plan.chiefId, planId: plan.id, conversationId: plan.conversationId, simulated: plan.simulated });
    plan.artifactId = artifact.id;
    await postBotMessage(
      plan.conversationId,
      plan.chiefId,
      [
        { kind: "text", text: postedResult ? `**${plan.status === "failed" ? "Failed" : "Finished"}:** ${summary}. The full report is saved below.` : `**Finished with gaps:** ${summary}.\n\n${plan.result}` },
        { kind: "artifact", artifactId: artifact.id, title: artifact.title, path: artifactUrl(artifact.file) },
      ],
      { by: "chief", planId: plan.id },
      { simulated: plan.simulated || undefined },
    );
    appendScope("history", `${plan.goal} (${summary}; report: ${artifact.file})`, { by: chief?.name ?? "Chief of Staff", why: "a plan finished", source: `plan ${plan.id}` });
  }
  if (plan.status === "failed") {
    await postNotice(plan.conversationId, `The plan failed: ${summary}. ${failed.map((t) => `${t.ref}: ${t.error ?? t.status}`).join(" ")} Open the task dashboard to retry a task.`);
    appendScope("history", `${plan.goal} (failed: ${summary})`, { by: chief?.name ?? "Chief of Staff", why: "a plan failed", source: `plan ${plan.id}` });
  }
  event(plan, plan.status, plan.status === "cancelled" ? "Plan cancelled." : `Plan ${plan.status}: ${summary}.`);
  await savePlan(plan);
  publish({ type: "plan", plan });
  runners.delete(plan.id);
  run.finish(plan);
}

// ── controls ────────────────────────────────────────────────────────────

/** Resolves when the plan ends. */
export async function waitForPlan(planId: string): Promise<Plan | null> {
  const run = runners.get(planId);
  return run ? run.done : getPlan(planId);
}

export async function cancelPlan(planId: string, why = "Cancelled by you."): Promise<Plan | null> {
  const run = runners.get(planId);
  const plan = run?.plan ?? (await getPlan(planId));
  if (!plan || ["done", "failed", "cancelled"].includes(plan.status)) return plan;
  plan.status = "cancelled";
  event(plan, "cancel", why);
  for (const task of plan.tasks) {
    if (task.status === "pending" || task.status === "interrupted") {
      task.status = "cancelled";
      task.finishedAt = now();
    }
  }
  if (run) {
    // Stopping a turn also releases any approval it waits on as "cancelled": that action never runs.
    for (const botId of new Set(run.running.values())) await stopTurn(plan.conversationId, botId);
    run.signal.fire();
  } else {
    plan.finishedAt = now();
    await savePlan(plan);
    publish({ type: "plan", plan });
  }
  return plan;
}

export async function cancelTask(planId: string, taskId: string): Promise<Plan | null> {
  const run = runners.get(planId);
  if (!run) return getPlan(planId);
  const task = run.plan.tasks.find((t) => t.id === taskId);
  if (!task || isOver(task)) return run.plan;
  if (task.status === "pending") {
    task.status = "cancelled";
    task.error = "Cancelled.";
    task.finishedAt = now();
    event(run.plan, "task-cancelled", `${task.ref} cancelled before it started.`, task.id);
  } else {
    run.cancelled.add(task.id);
    await stopTurn(run.plan.conversationId, task.agentId);
  }
  run.signal.fire();
  return run.plan;
}

/** Run a failed, cancelled or interrupted task again; the final answer is rebuilt after it. */
export async function retryTask(planId: string, taskId: string): Promise<Plan | null> {
  const plan = runners.get(planId)?.plan ?? (await getPlan(planId));
  const task = plan?.tasks.find((t) => t.id === taskId);
  if (!plan || !task || task.status === "running" || task.status === "pending" || task.status === "awaiting-approval") return plan;
  const reset = (t: Task) => {
    t.status = "pending";
    t.error = undefined;
    t.finishedAt = undefined;
    t.maxAttempts = t.attempts.length + 1;
  };
  reset(task);
  for (const t of plan.tasks) if (t.kind === "consolidate" || (t.status === "skipped" && t.dependsOn.includes(task.id))) reset(t);
  event(plan, "retry", `${task.ref} was sent back to run again.`, task.id);
  plan.status = "running";
  plan.finishedAt = undefined;
  if (runners.has(planId)) runners.get(planId)!.signal.fire();
  else launch(plan);
  return plan;
}

/** Continue a plan that a restart interrupted. Finished tasks keep their results. */
export async function resumePlan(planId: string): Promise<Plan | null> {
  if (runners.has(planId)) return runners.get(planId)!.plan;
  const plan = await getPlan(planId);
  if (!plan || plan.status !== "interrupted") return plan;
  for (const task of plan.tasks) {
    if (task.status !== "interrupted") continue;
    task.status = "pending";
    task.error = undefined;
    task.maxAttempts = Math.max(task.maxAttempts, task.attempts.length + 1);
  }
  plan.status = "running";
  const kept = plan.tasks.filter((t) => t.status === "done").length;
  event(plan, "resumed", `Resumed after a restart. ${kept} finished task${kept === 1 ? "" : "s"} kept; the rest continue.`);
  await savePlan(plan);
  launch(plan);
  return plan;
}

/** At startup: plans that were running when the server stopped are marked interrupted. */
export async function recoverPlans(): Promise<number> {
  const stale = (await plansWithStatus(["planning", "running", "awaiting-approval"])).filter((p) => !runners.has(p.id));
  for (const plan of stale) {
    for (const task of plan.tasks) {
      if (task.status !== "running" && task.status !== "awaiting-approval") continue;
      task.status = "interrupted";
      task.error = "Interrupted by a server restart.";
      const last = task.attempts[task.attempts.length - 1];
      if (last && !last.finishedAt) {
        last.status = "interrupted";
        last.finishedAt = now();
      }
    }
    plan.status = "interrupted";
    event(plan, "interrupted", "The server restarted while this plan was running. Press Resume to continue from where it stopped.");
    await savePlan(plan);
    await postNotice(plan.conversationId, `The plan "${plan.goal}" was interrupted by a restart. Finished tasks are kept. Press **Resume** on the plan, or send "resume".`);
    if (process.env.OPENCREWBOT_AUTO_RESUME === "1") await resumePlan(plan.id);
  }
  return stale.length;
}

/** A new instruction arrived while the plan runs. */
export async function amendPlan(planId: string, text: string): Promise<Plan | null> {
  const run = runners.get(planId);
  if (!run) return null;
  const plan = run.plan;
  if (/^\s*(stop|cancel|abort)\b/i.test(text)) return cancelPlan(planId, `Cancelled by your message: "${text.slice(0, 80)}"`);
  plan.amendments.push({ at: now(), text });
  event(plan, "amended", `New instruction received: "${text.slice(0, 160)}"`);
  const chief = await getBot(plan.chiefId);
  const { team } = await teamFor(plan);
  if (!chief) return plan;

  markBusy(plan.conversationId, chief.id, true);
  let change;
  try {
    change = await planAmendment(plan, text, chief, team);
  } finally {
    markBusy(plan.conversationId, chief.id, false);
  }
  for (const ref of change.cancel) {
    const task = plan.tasks.find((t) => t.ref === ref);
    if (task) await cancelTask(plan.id, task.id);
  }
  const room = plan.tasks.length + change.add.length <= plan.budget.maxTasks ? change.add : change.add.slice(0, Math.max(0, plan.budget.maxTasks - plan.tasks.length));
  const consolidate = plan.tasks.find((t) => t.kind === "consolidate");
  if (consolidate) plan.tasks.splice(plan.tasks.indexOf(consolidate), 1);
  const added = addTasks(plan, room.filter((t) => t.agentId), "replan");
  if (consolidate) plan.tasks.push(consolidate);
  ensureConsolidation(plan);
  // A final answer that is already being written must be rewritten with the new instruction.
  if (consolidate?.status === "running") {
    run.restart.add(consolidate.id);
    await stopTurn(plan.conversationId, consolidate.agentId);
  }
  const running = plan.tasks.filter((t) => t.status === "running" && t.kind !== "consolidate").map((t) => t.ref);
  event(plan, "replanned", `${change.note}${added.length ? ` Added: ${added.map((t) => t.ref).join(", ")}.` : ""}`);
  await postBotMessage(
    plan.conversationId,
    chief.id,
    [{ kind: "text", text: `**${change.note.replace(/^Plan updated[:.]\s*/i, "Plan updated: ")}**${running.length ? `\n\n${running.join(", ")} ${running.length > 1 ? "are" : "is"} already running and will finish; every later task and the final answer follow your new instruction.` : ""}` }],
    { by: "chief", planId: plan.id },
    { simulated: plan.simulated || undefined },
  );
  await persist(plan);
  run.signal.fire();
  return plan;
}

// ── used by the collaboration tools ─────────────────────────────────────

/** A teammate hands part of its task to another agent. Refused when a guard trips. */
export async function addDelegatedTask(planId: string, parentTaskId: string | undefined, from: Bot, to: Bot, brief: string, reason: string): Promise<{ ok: boolean; ref?: string; reason?: string }> {
  const run = runners.get(planId);
  if (!run) return { ok: false, reason: "the plan is no longer running" };
  const plan = run.plan;
  const parent = plan.tasks.find((t) => t.id === parentTaskId);
  const depth = (parent?.depth ?? 0) + 1;
  if (to.id === from.id) return { ok: false, reason: "you cannot delegate to yourself" };
  if (depth > MAX_DELEGATION_DEPTH) return { ok: false, reason: `delegation chains stop at ${MAX_DELEGATION_DEPTH} levels, to prevent loops` };
  if (plan.budget.delegations >= plan.budget.maxDelegations) return { ok: false, reason: `this plan has used all ${plan.budget.maxDelegations} delegations` };
  if (plan.tasks.length >= plan.budget.maxTasks) return { ok: false, reason: `this plan is at its limit of ${plan.budget.maxTasks} tasks` };
  const giver = plan.tasks.find((t) => t.id === parent?.parentTaskId);
  if (parent?.origin === "delegation" && giver?.agentId === to.id) return { ok: false, reason: `${to.name} delegated this to you; handing it back would loop` };
  if (plan.tasks.some((t) => t.origin === "delegation" && t.agentId === to.id && t.description.includes(brief.slice(0, 80)))) return { ok: false, reason: "this was already delegated" };

  plan.budget.delegations++;
  const task = newTask(
    plan,
    { ref: `T${plan.tasks.length + 1}`, title: brief.split(/[.\n]/)[0].slice(0, 80), description: `Delegated by ${from.name}${parent ? ` while working on ${parent.ref}` : ""}${reason ? ` (${reason})` : ""}.\n\n${brief}`, agentId: to.id, dependsOn: [], skills: skillsFor(brief, to), capability: "delegated work", kind: "work", needsApproval: false },
    "delegation",
    { parentTaskId, depth },
  );
  const at = plan.tasks.findIndex((t) => t.kind === "consolidate");
  plan.tasks.splice(at < 0 ? plan.tasks.length : at, 0, task);
  ensureConsolidation(plan);
  event(plan, "delegated", `${from.name} delegated ${task.ref} "${task.title}" to ${to.name}.`, task.id);
  await persist(plan);
  run.signal.fire();
  return { ok: true, ref: task.ref };
}

/** Count one agent-to-agent message against the plan's budget. False when the budget is spent. */
export function spendTeammateMessage(planId: string | undefined): boolean {
  const plan = planId ? runners.get(planId)?.plan : undefined;
  if (!plan) return true;
  if (plan.budget.teammateMessages >= plan.budget.maxTeammateMessages) return false;
  plan.budget.teammateMessages++;
  return true;
}

export function noteOnPlan(planId: string | undefined, kind: string, text: string, taskId?: string) {
  const plan = planId ? runners.get(planId)?.plan : undefined;
  if (!plan) return;
  event(plan, kind, text, taskId);
  void persist(plan);
}

export async function lastPlanIn(conversationId: ConversationId): Promise<Plan | undefined> {
  return (await listPlans(200)).find((p) => p.conversationId === conversationId);
}
