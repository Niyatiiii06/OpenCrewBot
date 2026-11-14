// Scheduled workflows: a saved instruction that the Chief of Staff runs as a
// plan on a schedule or on demand. Each run is recorded with its status, its
// report and any failure. A timer inside the server checks once a minute, so
// workflows run while the app is running.
import { randomUUID } from "node:crypto";
import type { Workflow, WorkflowRun, WorkflowSchedule } from "@/lib/shared/types";
import { publish } from "./bus";
import { deleteWorkflowRow, getRoom, getWorkflow, listBots, listWorkflowRuns, listWorkflows, saveWorkflow, saveWorkflowRun } from "./db";
import { activePlanIn, startPlan, waitForPlan } from "./engine";
import { InputError } from "./errors";
import { audit } from "./permissions";
import { postNotice } from "./runtime";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "every 30 minutes", "hourly", "daily 09:00", "weekly monday 09:00", "manual". */
export function parseSchedule(text: string): WorkflowSchedule {
  const t = text.trim().toLowerCase();
  const time = t.match(/(\d{1,2})[:.](\d{2})/);
  const hhmm = time ? `${time[1].padStart(2, "0")}:${time[2]}` : "09:00";
  const every = t.match(/every\s+(\d+)\s*(min|hour|day)/);
  if (every) {
    const n = Number(every[1]);
    if (every[2] === "day") return n === 1 ? { type: "daily", time: hhmm } : { type: "interval", minutes: n * 1440 };
    return { type: "interval", minutes: Math.max(1, every[2] === "hour" ? n * 60 : n) };
  }
  if (/hourly|every hour/.test(t)) return { type: "interval", minutes: 60 };
  const day = DAYS.findIndex((d) => t.includes(d) || t.includes(d.slice(0, 3) + " "));
  if (/week/.test(t) || day >= 0) return { type: "weekly", day: day >= 0 ? day : 1, time: hhmm };
  if (/daily|every day|each day|morning|evening/.test(t) || time) return { type: "daily", time: hhmm };
  return { type: "manual" };
}

export function describeSchedule(s: WorkflowSchedule): string {
  if (s.type === "interval") return s.minutes % 1440 === 0 ? `every ${s.minutes / 1440} days` : s.minutes % 60 === 0 ? `every ${s.minutes / 60} hour${s.minutes === 60 ? "" : "s"}` : `every ${s.minutes} minutes`;
  if (s.type === "daily") return `daily at ${s.time}`;
  if (s.type === "weekly") return `weekly on ${DAYS[s.day]} at ${s.time}`;
  return "manual only";
}

/** The next time a schedule fires after `from` (server local time). */
export function nextRun(s: WorkflowSchedule, from = new Date()): string | undefined {
  if (s.type === "manual") return undefined;
  if (s.type === "interval") return new Date(from.getTime() + s.minutes * 60_000).toISOString();
  const [h, m] = s.time.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h || 0, m || 0, 0, 0);
  if (s.type === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  let add = (s.day - next.getDay() + 7) % 7;
  if (add === 0 && next <= from) add = 7;
  next.setDate(next.getDate() + add);
  return next.toISOString();
}

export interface WorkflowInput {
  name: string;
  instruction: string;
  schedule: WorkflowSchedule;
  conversationId: string;
}

async function check(input: Partial<WorkflowInput>) {
  if (input.name !== undefined && !input.name.trim()) throw new InputError("A workflow needs a name.");
  if (input.instruction !== undefined && input.instruction.trim().length < 5) throw new InputError("Say what the workflow should do.");
  if (input.conversationId !== undefined) {
    const room = input.conversationId.startsWith("room:") ? await getRoom(input.conversationId.slice(5)) : null;
    if (!room) throw new InputError("Choose a room for the workflow to run in.");
  }
  if (input.schedule?.type === "interval" && input.schedule.minutes < 1) throw new InputError("The shortest interval is one minute.");
}

export async function createWorkflow(input: WorkflowInput): Promise<Workflow> {
  // A workflow made from a direct message has no room; use the first room with a Chief of Staff.
  if (!input.conversationId.startsWith("room:")) {
    const { listRooms } = await import("./db");
    const rooms = await listRooms();
    const room = rooms.find((r) => r.responder === "chief") ?? rooms[0];
    if (room) input = { ...input, conversationId: `room:${room.id}` };
  }
  await check(input);
  const workflow: Workflow = {
    id: randomUUID().slice(0, 8),
    name: input.name.trim(),
    instruction: input.instruction.trim(),
    conversationId: input.conversationId,
    schedule: input.schedule,
    status: "active",
    createdAt: new Date().toISOString(),
    nextRunAt: nextRun(input.schedule),
    failures: 0,
  };
  await saveWorkflow(workflow);
  publish({ type: "workflows-changed" });
  return workflow;
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowInput> & { status?: Workflow["status"] }): Promise<Workflow> {
  const workflow = await getWorkflow(id);
  if (!workflow) throw new InputError("That workflow doesn't exist.");
  await check(patch);
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next: Workflow = { ...workflow, ...changes, id: workflow.id, createdAt: workflow.createdAt };
  // Changing the schedule or resuming starts the clock again from now.
  if (patch.schedule || (patch.status === "active" && workflow.status === "paused")) next.nextRunAt = nextRun(next.schedule);
  if (next.status === "paused") next.nextRunAt = undefined;
  await saveWorkflow(next);
  publish({ type: "workflows-changed" });
  return next;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await deleteWorkflowRow(id);
  publish({ type: "workflows-changed" });
}

const g = globalThis as unknown as { __opencrewbotScheduler?: { timer?: ReturnType<typeof setInterval>; running: Set<string> } };
const scheduler = (g.__opencrewbotScheduler ??= { running: new Set<string>() });

/** Run a workflow now. Resolves when the run has been recorded as started. */
export async function runWorkflow(id: string, trigger: WorkflowRun["trigger"]): Promise<WorkflowRun> {
  const workflow = await getWorkflow(id);
  if (!workflow) throw new InputError("That workflow doesn't exist.");
  const run: WorkflowRun = { id: randomUUID().slice(0, 8), workflowId: id, trigger, startedAt: new Date().toISOString(), status: "running" };

  const fail = async (error: string) => {
    run.status = "failed";
    run.error = error;
    run.finishedAt = new Date().toISOString();
    await saveWorkflowRun(run);
    const fresh = (await getWorkflow(id)) ?? workflow;
    await saveWorkflow({ ...fresh, lastRunAt: run.startedAt, lastStatus: "failed", failures: fresh.failures + 1 });
    await audit({ event: "workflow-failed", detail: `Workflow "${workflow.name}" failed: ${error}`, conversationId: workflow.conversationId });
    await postNotice(workflow.conversationId, `⚠️ Workflow **${workflow.name}** failed: ${error}`).catch(() => {});
    publish({ type: "workflows-changed" });
    return run;
  };

  if (scheduler.running.has(id)) return fail("The previous run of this workflow is still going, so this run was skipped.");
  if (activePlanIn(workflow.conversationId)) return fail("Another plan is running in this room, so this run was skipped.");
  const room = await getRoom(workflow.conversationId.slice(5));
  if (!room) return fail("The workflow's room was deleted.");
  const bots = await listBots();
  const members = bots.filter((b) => room.memberIds.includes(b.id));
  const chief = members.find((b) => b.role === "chief") ?? bots.find((b) => b.role === "chief");
  if (!chief) return fail("There is no Chief of Staff agent to run the workflow.");

  scheduler.running.add(id);
  await saveWorkflowRun(run);
  await saveWorkflow({ ...workflow, lastRunAt: run.startedAt, lastStatus: "running" });
  publish({ type: "workflows-changed" });
  await postNotice(workflow.conversationId, `⏱️ Workflow **${workflow.name}** started (${trigger === "manual" ? "run by you" : "on schedule"}).`);

  void (async () => {
    try {
      const plan = await startPlan({ conversationId: workflow.conversationId, instruction: workflow.instruction, chief, workflowId: id });
      if (!plan) throw new Error("The instruction did not produce a plan.");
      run.planId = plan.id;
      await saveWorkflowRun(run);
      const finished = (await waitForPlan(plan.id)) ?? plan;
      const done = finished.tasks.filter((t) => t.status === "done").length;
      run.finishedAt = new Date().toISOString();
      run.artifactId = finished.artifactId;
      run.summary = `${done} of ${finished.tasks.length} tasks done.`;
      if (finished.status === "done") run.status = "done";
      else if (finished.status === "cancelled") run.status = "cancelled";
      else {
        const why = finished.tasks.filter((t) => t.error).map((t) => `${t.ref}: ${t.error}`).join(" ");
        scheduler.running.delete(id);
        await fail(`The plan ended as ${finished.status}. ${why}`.trim());
        return;
      }
      await saveWorkflowRun(run);
      const fresh = (await getWorkflow(id)) ?? workflow;
      await saveWorkflow({ ...fresh, lastRunAt: run.startedAt, lastStatus: run.status });
    } catch (error) {
      scheduler.running.delete(id);
      await fail(error instanceof Error ? error.message : String(error));
    } finally {
      scheduler.running.delete(id);
      publish({ type: "workflows-changed" });
    }
  })();
  return run;
}

/** Run every active workflow whose time has come. */
export async function tick(): Promise<void> {
  const nowTime = new Date();
  for (const workflow of await listWorkflows()) {
    if (workflow.status !== "active" || !workflow.nextRunAt || new Date(workflow.nextRunAt) > nowTime) continue;
    // Set the next time first, so a slow run can never fire twice.
    await saveWorkflow({ ...workflow, nextRunAt: nextRun(workflow.schedule, nowTime) });
    await runWorkflow(workflow.id, "schedule").catch(() => {});
  }
}

export function startScheduler(): void {
  if (scheduler.timer) return;
  scheduler.timer = setInterval(() => void tick().catch(() => {}), 30_000);
  scheduler.timer.unref?.();
}

/** Runs still marked "running" belong to a server that stopped. */
export async function recoverWorkflowRuns(): Promise<void> {
  for (const run of await listWorkflowRuns(undefined, 200)) {
    if (run.status !== "running") continue;
    await saveWorkflowRun({ ...run, status: "failed", error: "Interrupted by a server restart.", finishedAt: new Date().toISOString() });
    const workflow = await getWorkflow(run.workflowId);
    if (workflow) await saveWorkflow({ ...workflow, lastStatus: "failed", failures: workflow.failures + 1 });
  }
}
