// Human approval and autonomy. Three levels per bot:
//
//   Ask first    every external or sensitive action waits for you
//   Controlled   pre-approved actions run on their own, inside limits; the rest ask
//   Full access  permitted actions run on their own
//
// A per-tool override (allow / ask / deny) beats the level. Every request,
// decision and execution is written to the audit log. An action that is rejected,
// cancelled or left unanswered across a restart is never carried out: the code
// that performs it runs only after `gate()` returns "approved" or "allowed".
import { randomUUID } from "node:crypto";
import type { Approval, AuditEntry, Bot } from "@/lib/shared/types";
import { addAudit, getApproval, getBot, pendingApprovals, saveApproval } from "./db";
import { publish } from "./bus";
import type { TurnContext } from "./turns";

export type Risk = "read" | "local" | "external";

export interface ToolMeta {
  label: string;
  group: string;
  description: string;
  risk: Risk;
  /** What the action will do, in words, plus the exact content for the preview. */
  describe?: (args: Record<string, unknown>) => { title: string; preview: string };
}

/** Filled in by native-tools.ts as tools are defined, so the catalog has one source. */
export const TOOL_META = new Map<string, ToolMeta>();

export async function audit(entry: Omit<AuditEntry, "id" | "at">): Promise<void> {
  await addAudit({ id: randomUUID(), at: new Date().toISOString(), ...entry }).catch(() => {});
}

// ── deciding whether a call may run ─────────────────────────────────────

export interface Decision {
  policy: "allow" | "ask" | "deny";
  reason: string;
}

const domainOf = (address: string) => address.trim().toLowerCase().split("@").pop() ?? "";

/** Is this call one of the pre-approved actions of a Controlled-access bot? */
function preApproved(bot: Bot, tool: string, args: Record<string, unknown>): string | null {
  if (tool === "send_email") {
    const recipients = String(args.to ?? "").split(/[,;\s]+/).filter(Boolean);
    const allowed = bot.limits.allowedEmailDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
    if (recipients.length && allowed.length && recipients.every((r) => allowed.includes(domainOf(r)))) return `every recipient is on an approved domain (${allowed.join(", ")})`;
    return null;
  }
  if (tool === "github_create_issue") {
    const repo = String(args.repo ?? "").toLowerCase();
    if (bot.limits.allowedRepos.map((r) => r.toLowerCase()).includes(repo)) return `${repo} is an approved repository`;
    return null;
  }
  return null;
}

export function decide(bot: Bot, tool: string, args: Record<string, unknown>, actionsSoFar: number): Decision {
  const override = bot.toolPolicy[tool];
  if (override === "deny") return { policy: "deny", reason: `${bot.name} is not permitted to use this tool` };
  const risk = TOOL_META.get(tool)?.risk ?? "external";
  if (risk !== "external") return { policy: "allow", reason: "not an external action" };
  if (override === "ask") return { policy: "ask", reason: "this tool is set to always ask" };
  if (bot.approval === "full") return { policy: "allow", reason: "Full access" };
  if (bot.approval === "ask") return { policy: "ask", reason: "Ask first" };
  // Controlled access
  if (actionsSoFar >= bot.limits.maxActionsPerRun) {
    return { policy: "ask", reason: `Controlled access: the limit of ${bot.limits.maxActionsPerRun} actions per run is used up` };
  }
  if (override === "allow") return { policy: "allow", reason: "Controlled access: this tool is pre-approved" };
  const why = preApproved(bot, tool, args);
  if (why) return { policy: "allow", reason: `Controlled access: ${why}` };
  return { policy: "ask", reason: "Controlled access: not a pre-approved action" };
}

// ── approvals that are waiting on the person ────────────────────────────

type Outcome = "approved" | "rejected" | "cancelled";

const g = globalThis as unknown as { __opencrewbotGate?: Map<string, (outcome: Outcome) => void> };
/** approvalId → resolver of the tool call that is waiting. Lives only in this process. */
const waiting = (g.__opencrewbotGate ??= new Map());

export async function recordApproval(input: Omit<Approval, "id" | "createdAt" | "status">): Promise<Approval> {
  const approval: Approval = { ...input, id: randomUUID().slice(0, 10), status: "pending", createdAt: new Date().toISOString() };
  await saveApproval(approval);
  const bot = await getBot(approval.botId);
  await audit({
    event: "approval-requested",
    botId: approval.botId,
    botName: bot?.name,
    tool: approval.tool,
    detail: approval.title,
    conversationId: approval.conversationId,
    approvalId: approval.id,
    planId: approval.planId,
    taskId: approval.taskId,
  });
  publish({ type: "approvals-changed" });
  return approval;
}

export async function settleApproval(id: string, status: Approval["status"], by: Approval["decidedBy"], note?: string): Promise<Approval | null> {
  const approval = await getApproval(id);
  if (!approval || approval.status !== "pending") return approval;
  const next: Approval = { ...approval, status, decidedAt: new Date().toISOString(), decidedBy: by, note };
  await saveApproval(next);
  const bot = await getBot(next.botId);
  await audit({
    event: status,
    botId: next.botId,
    botName: bot?.name,
    tool: next.tool,
    detail:
      status === "approved"
        ? `Approved by you: ${next.title}`
        : `${status === "rejected" ? "Rejected by you" : status === "expired" ? "Expired (the app restarted while it waited)" : "Cancelled"}: ${next.title}. The action was NOT executed.`,
    conversationId: next.conversationId,
    approvalId: next.id,
    planId: next.planId,
    taskId: next.taskId,
  });
  publish({ type: "approvals-changed" });
  return next;
}

/** Find the pending approval for a tool call, whichever mechanism raised it. */
export async function pendingFor(conversationId: string, botId: string, toolCallId: string): Promise<Approval | undefined> {
  return (await pendingApprovals()).find((a) => a.conversationId === conversationId && a.botId === botId && a.toolCallId === toolCallId);
}

/** Resolve a gate that is waiting in this process. False when nothing is waiting on it. */
export function releaseGate(approvalId: string, outcome: Outcome): boolean {
  const resolve = waiting.get(approvalId);
  if (!resolve) return false;
  waiting.delete(approvalId);
  resolve(outcome);
  return true;
}

/** After a restart nothing can answer the approvals that were pending: the tool calls
 * that waited on them are gone. Mark them expired so they can never be approved late. */
export async function expirePendingApprovals(): Promise<number> {
  const pending = await pendingApprovals();
  for (const a of pending) await settleApproval(a.id, "expired", "system", "The app restarted before a decision was made.");
  return pending.length;
}

export interface GateResult {
  allowed: boolean;
  outcome: "allowed" | "approved" | "rejected" | "cancelled" | "denied";
  reason: string;
  approvalId?: string;
}

/** The single checkpoint in front of every external action. Returns only once the
 * call is cleared to run or has been refused. */
export async function gate(bot: Bot, tool: string, args: Record<string, unknown>, turn: TurnContext & { toolCallId: string }): Promise<GateResult> {
  const decision = decide(bot, tool, args, turn.actions);
  const meta = TOOL_META.get(tool);
  const described = meta?.describe?.(args) ?? { title: meta?.label ?? tool, preview: JSON.stringify(args, null, 2) };
  const base = { botId: bot.id, botName: bot.name, tool, conversationId: turn.conversationId, planId: turn.planId, taskId: turn.taskId };

  if (decision.policy === "deny") {
    await audit({ ...base, event: "blocked", detail: `${described.title}. Blocked: ${decision.reason}. The action was NOT executed.` });
    return { allowed: false, outcome: "denied", reason: decision.reason };
  }
  if (decision.policy === "allow") {
    turn.actions++;
    await audit({ ...base, event: "auto-allowed", detail: `${described.title}. Allowed without asking: ${decision.reason}.` });
    return { allowed: true, outcome: "allowed", reason: decision.reason };
  }

  const approval = await recordApproval({
    conversationId: turn.conversationId,
    botId: bot.id,
    toolCallId: turn.toolCallId,
    tool,
    title: described.title,
    preview: described.preview.slice(0, 6000),
    args,
    planId: turn.planId,
    taskId: turn.taskId,
    note: decision.reason,
  });
  turn.markAwaiting?.(turn.toolCallId, true, described.preview.slice(0, 4000));
  turn.onWaiting?.(true);
  const outcome = await new Promise<Outcome>((resolve) => {
    waiting.set(approval.id, resolve);
    turn.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
    if (turn.signal?.aborted) resolve("cancelled");
  });
  waiting.delete(approval.id);
  turn.markAwaiting?.(turn.toolCallId, false);
  turn.onWaiting?.(false);
  if (outcome === "cancelled") await settleApproval(approval.id, "cancelled", "system", "The run was stopped before a decision was made.");
  if (outcome !== "approved") return { allowed: false, outcome, reason: outcome === "rejected" ? "rejected by the person" : "the run was cancelled", approvalId: approval.id };
  turn.actions++;
  return { allowed: true, outcome: "approved", reason: "approved by the person", approvalId: approval.id };
}

/** Record that an approved or allowed action really ran. */
export async function recordExecution(bot: Bot, tool: string, detail: string, turn: TurnContext, simulated: boolean, approvalId?: string): Promise<void> {
  await audit({
    event: "executed",
    botId: bot.id,
    botName: bot.name,
    tool,
    detail: simulated ? `SIMULATED (the service is not connected): ${detail}` : detail,
    conversationId: turn.conversationId,
    planId: turn.planId,
    taskId: turn.taskId,
    approvalId,
    simulated,
  });
  if (approvalId) {
    const approval = await getApproval(approvalId);
    if (approval) await saveApproval({ ...approval, executedAt: new Date().toISOString() });
    publish({ type: "approvals-changed" });
  }
}
