"use client";

import clsx from "clsx";
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, Clock, FileText, Loader2, RotateCcw, ShieldAlert, SkipForward, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { formatCost, formatTokens, timeLabel } from "@/lib/client/format";
import type { Plan, Task, TaskStatus } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { BotAvatar, Button } from "./ui";

const STATUS: Record<TaskStatus, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "text-faint" },
  running: { label: "Running", tone: "text-[#8db4ff]" },
  "awaiting-approval": { label: "Needs approval", tone: "text-warn" },
  done: { label: "Done", tone: "text-ok" },
  failed: { label: "Failed", tone: "text-danger" },
  cancelled: { label: "Cancelled", tone: "text-faint" },
  skipped: { label: "Skipped", tone: "text-faint" },
  "timed-out": { label: "Timed out", tone: "text-danger" },
  interrupted: { label: "Interrupted", tone: "text-warn" },
};

function StatusIcon({ status }: { status: TaskStatus }) {
  const size = 14;
  if (status === "running") return <Loader2 size={size} className="animate-spin text-[#8db4ff]" />;
  if (status === "done") return <Check size={size} className="text-ok" />;
  if (status === "awaiting-approval") return <ShieldAlert size={size} className="text-warn" />;
  if (status === "failed") return <X size={size} className="text-danger" />;
  if (status === "timed-out") return <Clock size={size} className="text-danger" />;
  if (status === "interrupted") return <AlertTriangle size={size} className="text-warn" />;
  if (status === "cancelled") return <Ban size={size} className="text-faint" />;
  if (status === "skipped") return <SkipForward size={size} className="text-faint" />;
  return <CircleDashed size={size} className="text-faint" />;
}

const seconds = (from?: string, to?: string) => {
  if (!from) return "";
  const s = Math.max(0, Math.round((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function TaskRow({ plan, task, detailed }: { plan: Plan; task: Task; detailed: boolean }) {
  const { state, toast } = useApp();
  const [open, setOpen] = useState(false);
  const bot = state.bots.find((b) => b.id === task.agentId);
  const original = task.originalAgentId ? state.bots.find((b) => b.id === task.originalAgentId) : undefined;
  const deps = task.dependsOn.map((id) => plan.tasks.find((t) => t.id === id)?.ref).filter(Boolean);
  const live = ["running", "pending", "awaiting-approval"].includes(task.status);
  const canRetry = ["failed", "timed-out", "cancelled", "skipped", "interrupted"].includes(task.status) && plan.status !== "running";
  const act = async (action: "cancel-task" | "retry-task") => {
    try {
      await api.planAction(plan.id, action, task.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "That didn't work.");
    }
  };
  return (
    <li className="border-t border-line first:border-t-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-hover">
        <StatusIcon status={task.status} />
        <span className="w-7 shrink-0 font-mono text-[11.5px] text-faint">{task.ref}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{task.title}</span>
        {bot && (
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-mute">
            <BotAvatar bot={bot} size={16} /> {bot.name}
          </span>
        )}
        <span className={clsx("w-[92px] shrink-0 text-right text-[12px]", STATUS[task.status].tone)}>{STATUS[task.status].label}</span>
        <ChevronRight size={13} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 bg-app/40 px-3.5 py-3 text-[12.5px] leading-relaxed text-mute">
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
            <dt className="text-faint">Task ID</dt>
            <dd className="font-mono">{task.id}</dd>
            <dt className="text-faint">Assigned agent</dt>
            <dd>
              {bot?.name ?? "deleted agent"}
              {original && ` (reassigned from ${original.name})`}
            </dd>
            <dt className="text-faint">Depends on</dt>
            <dd>{deps.length ? deps.join(", ") : task.kind === "consolidate" ? "all other tasks" : "nothing (can run in parallel)"}</dd>
            <dt className="text-faint">Started / ended</dt>
            <dd>
              {task.startedAt ? timeLabel(task.startedAt) : "not started"}
              {task.finishedAt ? ` → ${timeLabel(task.finishedAt)} (${seconds(task.startedAt, task.finishedAt)})` : task.startedAt ? ` · running ${seconds(task.startedAt)}` : ""}
            </dd>
            <dt className="text-faint">Attempts</dt>
            <dd>
              {task.attempts.length ? task.attempts.map((a) => `#${a.n} ${a.status}${a.model ? ` on ${a.model.split("/").pop()}` : ""}`).join(" · ") : "none yet"} (limit {task.maxAttempts}, timeout{" "}
              {Math.round(task.timeoutMs / 1000)}s)
            </dd>
            <dt className="text-faint">Approval</dt>
            <dd>{task.status === "awaiting-approval" ? "Waiting for you" : task.needsApproval ? "Required before the action runs" : "Not needed"}</dd>
            {task.skills.length > 0 && (
              <>
                <dt className="text-faint">Skills loaded</dt>
                <dd>{task.skills.join(", ")}</dd>
              </>
            )}
            {task.usage && (task.usage.input > 0 || task.usage.output > 0) && (
              <>
                <dt className="text-faint">Tokens</dt>
                <dd>
                  {formatTokens(task.usage.input + task.usage.output)} {formatCost(task.usage.costUsd) ?? ""}
                </dd>
              </>
            )}
            {task.origin !== "plan" && (
              <>
                <dt className="text-faint">Added by</dt>
                <dd>{task.origin === "delegation" ? "a teammate's delegation" : task.origin === "replan" ? "your new instruction" : "the review"}</dd>
              </>
            )}
          </dl>
          {detailed && <p className="whitespace-pre-wrap text-faint">{task.description.slice(0, 600)}</p>}
          {task.error && <p className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{task.error}</p>}
          {task.output && (
            <details>
              <summary className="cursor-pointer text-ink">Output</summary>
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-raised p-2.5 font-mono text-[11.5px] whitespace-pre-wrap">{task.output.slice(0, 6000)}</pre>
            </details>
          )}
          <div className="flex gap-2">
            {live && plan.status !== "interrupted" && (
              <Button size="sm" onClick={() => act("cancel-task")}>
                Cancel task
              </Button>
            )}
            {canRetry && (
              <Button size="sm" onClick={() => act("retry-task")}>
                <RotateCcw size={13} /> Retry task
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

const PLAN_TONE: Record<Plan["status"], string> = {
  planning: "text-mute",
  running: "text-[#8db4ff]",
  "awaiting-approval": "text-warn",
  done: "text-ok",
  failed: "text-danger",
  cancelled: "text-faint",
  interrupted: "text-warn",
};

/** A live task plan: every task with its agent, status and controls. */
export function PlanCard({ planId, detailed = false }: { planId: string; detailed?: boolean }) {
  const { state, dispatch, toast, setPage } = useApp();
  const plan = state.plans[planId];
  const [showLog, setShowLog] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (plan) return;
    fetch(`/api/plans/${planId}`)
      .then((r) => r.json())
      .then((d: { plan?: Plan }) => d.plan && dispatch({ type: "event", event: { type: "plan", plan: d.plan } }))
      .catch(() => {});
  }, [plan, planId, dispatch]);

  const active = plan && ["running", "awaiting-approval", "planning"].includes(plan.status);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  if (!plan) return <div className="rounded-2xl bg-raised-2 px-3.5 py-2.5 text-[13px] text-mute">Loading plan…</div>;
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const act = async (action: "cancel" | "resume") => {
    try {
      await api.planAction(plan.id, action);
    } catch (error) {
      toast(error instanceof Error ? error.message : "That didn't work.");
    }
  };
  return (
    <div className="overflow-hidden rounded-2xl bg-raised-2 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{detailed ? plan.goal : "Task plan"}</span>
        {plan.simulated && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">MOCK MODE</span>}
        <span className={clsx("text-[12.5px] font-medium", PLAN_TONE[plan.status])}>
          {plan.status.replace("-", " ")} · {done}/{plan.tasks.length}
        </span>
        <span className="text-[12px] text-faint">{seconds(plan.startedAt ?? plan.createdAt, plan.finishedAt)}</span>
      </div>
      <div className="h-1 bg-app">
        <div className="h-1 bg-accent transition-all" style={{ width: `${plan.tasks.length ? (plan.tasks.filter((t) => !["pending", "running", "awaiting-approval", "interrupted"].includes(t.status)).length / plan.tasks.length) * 100 : 0}%` }} />
      </div>
      <ul>
        {plan.tasks.map((task) => (
          <TaskRow key={task.id} plan={plan} task={task} detailed={detailed} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2">
        <span className="mr-auto text-[11.5px] text-faint">
          Plan {plan.id} · {plan.plannedBy === "model" ? `planned by ${plan.model?.split("/").pop()}` : "built-in rule planner"}
          {plan.usage.input + plan.usage.output > 0 && ` · ${formatTokens(plan.usage.input + plan.usage.output)} tokens ${formatCost(plan.usage.costUsd) ?? ""}`}
          {plan.amendments.length > 0 && ` · ${plan.amendments.length} new instruction${plan.amendments.length > 1 ? "s" : ""}`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setShowLog((s) => !s)}>
          {showLog ? "Hide log" : "Log"}
        </Button>
        {!detailed && (
          <Button size="sm" variant="ghost" onClick={() => setPage("tasks")}>
            Dashboard
          </Button>
        )}
        {plan.status === "interrupted" && (
          <Button size="sm" variant="primary" onClick={() => act("resume")}>
            Resume
          </Button>
        )}
        {(active || plan.status === "interrupted") && (
          <Button size="sm" variant="danger" onClick={() => act("cancel")}>
            Cancel plan
          </Button>
        )}
      </div>
      {showLog && (
        <ol className="max-h-56 space-y-1 overflow-auto border-t border-line bg-app/40 px-3.5 py-2.5 font-mono text-[11.5px] text-mute">
          {plan.events.map((e, i) => (
            <li key={i}>
              <span className="text-faint">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ArtifactLink({ title, path }: { title: string; path: string }) {
  const { showReport } = useApp();
  return (
    <a
      href={path}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!path.endsWith(".md")) return;
        e.preventDefault();
        showReport(title, path);
      }}
      className="flex items-center gap-2.5 rounded-2xl bg-raised-2 px-3.5 py-2.5 text-[13.5px] ring-1 ring-line hover:bg-hover"
    >
      <FileText size={15} className="shrink-0 text-mute" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="shrink-0 text-[12px] text-faint">Open report</span>
    </a>
  );
}
