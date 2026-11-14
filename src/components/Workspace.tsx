"use client";

// The OpenCrewBot 2.0 workspace pages. Each page loads its data from the API
// and reloads when the server says something changed.
import clsx from "clsx";
import { ArrowLeft, ArrowUpRight, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ArtifactRow, type WorkflowRow } from "@/lib/client/api";
import { formatCost, formatTokens, timeLabel } from "@/lib/client/format";
import type { Approval, AuditEntry, IntegrationInfo, MemoryLogEntry, MemoryScope, ModelOption, ProviderInfo, Skill, ToolInfo, UsageRow, UsageSummary, WorkflowRun } from "@/lib/shared/types";
import { Markdown } from "./Markdown";
import { useApp } from "./OpenCrewBotApp";
import { PlanCard } from "./PlanView";
import { Button, Field, IconButton, inputClass } from "./ui";

export type WorkspacePage = "tasks" | "approvals" | "memory" | "skills" | "integrations" | "models" | "workflows" | "history";

const TITLES: Record<WorkspacePage, { title: string; sub: string }> = {
  tasks: { title: "Task dashboard", sub: "Every plan the Chief of Staff is running, task by task." },
  approvals: { title: "Approval centre", sub: "Actions waiting for you, every past decision, and the audit log." },
  memory: { title: "Memory manager", sub: "Plain Markdown files. Edit any of them; agents read the current text on their next turn." },
  skills: { title: "Skills and tools", sub: "Skills are instructions loaded when a task calls for them. Tools are what agents can do." },
  integrations: { title: "Integration manager", sub: "What is connected to a real service and what is simulated." },
  models: { title: "Model configuration", sub: "Providers, routing, fallbacks, and what has been spent." },
  workflows: { title: "Scheduled workflows", sub: "Instructions the team runs on a schedule or on demand." },
  history: { title: "Execution history", sub: "Every plan, report and recorded action." },
};

// ── small shared pieces ─────────────────────────────────────────────────

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; reload: () => void; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what should trigger a reload
  }, [...deps, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-wide text-mute uppercase">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "mute" | "accent"; children: ReactNode }) {
  const tones = { ok: "bg-[rgb(52_199_123/0.14)] text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger", mute: "bg-raised-2 text-mute", accent: "bg-accent-soft text-[#8db4ff]" };
  return <span className={clsx("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase", tones[tone])}>{children}</span>;
}

const card = "rounded-2xl bg-raised ring-1 ring-line";
const th = "px-3 py-2 text-left text-[11.5px] font-medium text-faint";
const td = "px-3 py-2 align-top text-[13px]";
const Empty = ({ children }: { children: ReactNode }) => <p className={clsx(card, "px-4 py-6 text-center text-[13.5px] text-mute")}>{children}</p>;

function useBotName() {
  const { state } = useApp();
  return (id?: string) => state.bots.find((b) => b.id === id)?.name ?? "—";
}

function useConversationName() {
  const { state } = useApp();
  return (id?: string) => {
    if (!id) return "—";
    if (id.startsWith("room:")) return state.rooms.find((r) => r.id === id.slice(5))?.name ?? "deleted room";
    return `DM with ${state.bots.find((b) => b.id === id.slice(3))?.name ?? "deleted agent"}`;
  };
}

// ── tasks ───────────────────────────────────────────────────────────────

function TasksPage() {
  const { state, dispatch } = useApp();
  useEffect(() => {
    api.plans().then((d) => d.plans.forEach((plan) => dispatch({ type: "event", event: { type: "plan", plan } }))).catch(() => {});
  }, [dispatch]);
  const plans = Object.values(state.plans).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const count = (s: string[]) => plans.filter((p) => s.includes(p.status)).length;
  const tasks = plans.flatMap((p) => p.tasks);
  const stats = [
    { label: "Plans running", value: count(["running", "planning"]) },
    { label: "Waiting for approval", value: count(["awaiting-approval"]) },
    { label: "Interrupted", value: count(["interrupted"]) },
    { label: "Tasks done", value: tasks.filter((t) => t.status === "done").length },
    { label: "Tasks failed", value: tasks.filter((t) => t.status === "failed" || t.status === "timed-out").length },
  ];
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className={clsx(card, "px-3.5 py-3")}>
            <div className="text-[22px] font-semibold">{s.value}</div>
            <div className="text-[12px] text-mute">{s.label}</div>
          </div>
        ))}
      </div>
      {plans.length === 0 && <Empty>No plans yet. Open a room with the Chief of Staff (try Command Room) and give it a full instruction.</Empty>}
      <div className="space-y-4">
        {plans.slice(0, 30).map((p) => (
          <PlanCard key={p.id} planId={p.id} detailed />
        ))}
      </div>
    </>
  );
}

// ── approvals ───────────────────────────────────────────────────────────

const APPROVAL_TONE: Record<Approval["status"], "ok" | "warn" | "danger" | "mute"> = { pending: "warn", approved: "ok", rejected: "danger", expired: "mute", cancelled: "mute" };

function ApprovalsPage() {
  const { state, toast } = useApp();
  const botName = useBotName();
  const where = useConversationName();
  const { data } = useLoad(() => api.approvals(), [state.versions.approvals]);
  const decide = async (id: string, approve: boolean) => {
    try {
      await api.decide(id, approve);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't send that.");
    }
  };
  const pending = data?.approvals.filter((a) => a.status === "pending") ?? [];
  const past = data?.approvals.filter((a) => a.status !== "pending") ?? [];
  return (
    <>
      <Section title={`Waiting for you (${pending.length})`}>
        {pending.length === 0 && <Empty>Nothing is waiting. When an agent wants to send an email, post a message or change a repository, it stops and asks here.</Empty>}
        <div className="space-y-3">
          {pending.map((a) => (
            <div key={a.id} className="rounded-2xl bg-warn-soft p-4 ring-1 ring-warn/30">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-medium">{a.title}</span>
                <Badge tone="warn">pending</Badge>
              </div>
              <p className="mt-1 text-[12.5px] text-mute">
                {botName(a.botId)} in {where(a.conversationId)} · {timeLabel(a.createdAt)} · tool <code className="font-mono">{a.tool}</code>
                {a.note ? ` · ${a.note}` : ""}
              </p>
              <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-app p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">{a.preview}</pre>
              <div className="mt-3 flex justify-end gap-2">
                <Button onClick={() => decide(a.id, false)}>Reject</Button>
                <Button variant="primary" onClick={() => decide(a.id, true)}>
                  Approve
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Decisions">
        {past.length === 0 ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <div className={clsx(card, "overflow-x-auto")}>
            <table className="w-full">
              <thead>
                <tr>
                  {["When", "Agent", "Action", "Decision", "Executed?"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {past.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className={clsx(td, "whitespace-nowrap text-mute")}>{timeLabel(a.createdAt)}</td>
                    <td className={td}>{botName(a.botId)}</td>
                    <td className={td}>
                      <details>
                        <summary className="cursor-pointer">{a.title}</summary>
                        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-app p-2 font-mono text-[11.5px] whitespace-pre-wrap text-mute">{a.preview}</pre>
                      </details>
                    </td>
                    <td className={td}>
                      <Badge tone={APPROVAL_TONE[a.status]}>{a.status}</Badge>
                      {a.decidedBy && <span className="ml-1.5 text-[12px] text-faint">by {a.decidedBy}</span>}
                    </td>
                    <td className={clsx(td, a.executedAt ? "text-ok" : "text-mute")}>{a.executedAt ? `Yes, ${timeLabel(a.executedAt)}` : a.status === "approved" ? "Approved; see audit log" : "No. Never ran."}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Audit log">
        <AuditTable entries={data?.audit ?? []} />
      </Section>
    </>
  );
}

const AUDIT_TONE: Record<string, "ok" | "warn" | "danger" | "mute" | "accent"> = { executed: "ok", approved: "ok", rejected: "danger", blocked: "danger", failed: "danger", "approval-requested": "warn", "auto-allowed": "accent", "model-fallback": "warn", "workflow-failed": "danger" };

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <Empty>Nothing recorded yet.</Empty>;
  return (
    <div className={clsx(card, "max-h-[480px] overflow-auto")}>
      <table className="w-full">
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-line first:border-t-0">
              <td className={clsx(td, "whitespace-nowrap text-mute")}>{new Date(e.at).toLocaleString()}</td>
              <td className={td}>
                <Badge tone={AUDIT_TONE[e.event] ?? "mute"}>{e.event}</Badge>
              </td>
              <td className={clsx(td, "whitespace-nowrap")}>{e.botName ?? "System"}</td>
              <td className={clsx(td, "text-mute")}>
                {e.simulated && <Badge tone="warn">simulated</Badge>} {e.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── memory ──────────────────────────────────────────────────────────────

const KIND_LABEL: Record<MemoryScope["kind"], string> = { user: "Shared", project: "Shared", decisions: "Shared", history: "Shared", room: "Rooms", agent: "Agents" };

function MemoryPage() {
  const { state, toast } = useApp();
  const scopes = useLoad(() => api.memoryScopes(), [state.versions.memory, state.bots.length, state.rooms.length]);
  const [selected, setSelected] = useState("user");
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [why, setWhy] = useState("");
  const [log, setLog] = useState<MemoryLogEntry[]>([]);
  const [path, setPath] = useState("");
  const dirty = content !== null && content !== saved;

  // Reload the open file when an agent writes to it, unless there are unsaved edits.
  useEffect(() => {
    let cancelled = false;
    api
      .memoryScope(selected)
      .then((d) => {
        if (cancelled) return;
        setLog(d.log);
        setPath(d.path);
        setSaved(d.content);
        setContent((current) => (current !== null && current !== saved && current !== d.content ? current : d.content));
      })
      .catch((e: Error) => toast(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `saved` is read, not a trigger
  }, [selected, state.versions.memory, toast]);

  const pick = (id: string) => {
    if (dirty && !window.confirm("Discard your unsaved edits?")) return;
    setContent(null);
    setSelected(id);
  };
  const save = async () => {
    if (content === null) return;
    try {
      const d = await api.saveMemoryScope(selected, content, why);
      setSaved(d.content);
      setContent(d.content);
      setWhy("");
      toast("Saved. Agents use the new text from their next turn.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save.");
    }
  };
  const groups = ["Shared", "Rooms", "Agents"].map((g) => ({ g, items: (scopes.data?.scopes ?? []).filter((s) => KIND_LABEL[s.kind] === g) }));
  const current = scopes.data?.scopes.find((s) => s.id === selected);
  return (
    <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
      <nav className="space-y-4">
        {groups.map(({ g, items }) => (
          <div key={g}>
            <div className="mb-1 px-2 text-[11.5px] font-medium text-faint uppercase">{g}</div>
            {items.map((s) => (
              <button key={s.id} onClick={() => pick(s.id)} className={clsx("flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13.5px]", selected === s.id ? "bg-active" : "text-mute hover:bg-hover hover:text-ink")}>
                <span className="truncate">{s.title}</span>
                <span className="shrink-0 text-[11px] text-faint">{s.bytes > 1024 ? `${(s.bytes / 1024).toFixed(1)}k` : s.bytes}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0">
        <p className="mb-2 text-[13px] text-mute">{current?.description}</p>
        <textarea value={content ?? ""} onChange={(e) => setContent(e.target.value)} spellCheck={false} aria-label="Memory file" className={clsx(inputClass, "h-[42vh] min-h-[220px] resize-y rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed")} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={path}>
            {path}
          </span>
          {dirty && <input className={clsx(inputClass, "w-64 rounded-full py-1.5 text-[13px]")} placeholder="Why this change? (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />}
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setContent(saved)}>
              Revert
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
            Save
          </Button>
        </div>
        <h3 className="mt-6 mb-2 text-[13px] font-semibold tracking-wide text-mute uppercase">Provenance: what was remembered, when, by whom and why</h3>
        {log.length === 0 ? (
          <Empty>Nothing has been written to this file yet.</Empty>
        ) : (
          <div className={clsx(card, "max-h-[320px] overflow-auto")}>
            <table className="w-full">
              <thead>
                <tr>
                  {["When", "Who", "What", "Why", "Source"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className={clsx(td, "whitespace-nowrap text-mute")}>{new Date(l.at).toLocaleString()}</td>
                    <td className={clsx(td, "whitespace-nowrap")}>{l.by}</td>
                    <td className={td}>{l.text}</td>
                    <td className={clsx(td, "text-mute")}>{l.why}</td>
                    <td className={clsx(td, "text-faint")}>{l.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── skills and tools ────────────────────────────────────────────────────

const BLANK_SKILL = { name: "", description: "", triggers: "", tools: "", output: "", body: "" };

function SkillsPage() {
  const { state, toast } = useApp();
  const { data } = useLoad(() => api.skills(), [state.versions.skills, state.versions.integrations]);
  const files = useLoad(() => api.dataFiles(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<typeof BLANK_SKILL | null>(null);
  const list = (text: string) => text.split(",").map((t) => t.trim()).filter(Boolean);
  const save = async () => {
    if (!form) return;
    try {
      await api.saveSkill({ name: form.name, description: form.description, triggers: list(form.triggers), tools: list(form.tools), output: form.output, body: form.body });
      setForm(null);
      toast("Skill saved. Agents can load it from their next task; no restart needed.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save the skill.");
    }
  };
  const remove = async (skill: Skill) => {
    if (!window.confirm(`Delete the skill "${skill.name}"?`)) return;
    await api.deleteSkill(skill.id).catch((e: Error) => toast(e.message));
  };
  const upload = async (file: File) => {
    try {
      await api.upload(file.name, await file.text());
      files.reload();
      toast(`${file.name} uploaded. Ask the team to analyse it.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Upload failed.");
    }
  };
  const groups = [...new Set((data?.tools ?? []).map((t) => t.group))];
  return (
    <>
      <Section
        title={`Skills (${data?.skills.length ?? 0})`}
        right={
          <Button size="sm" variant="primary" onClick={() => setForm(form ? null : BLANK_SKILL)}>
            {form ? "Close" : "New skill"}
          </Button>
        }
      >
        {form && (
          <div className={clsx(card, "mb-3 space-y-3 p-4")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Scholarship research" />
              </Field>
              <Field label="When to use it (one line)">
                <input className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label="Trigger words" hint="Comma-separated. A task that contains them loads this skill.">
                <input className={inputClass} value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} placeholder="scholarship, funding, grant" />
              </Field>
              <Field label="Tools it uses" hint="Comma-separated tool names.">
                <input className={inputClass} value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} placeholder="web_search, read_page" />
              </Field>
            </div>
            <Field label="Expected output">
              <input className={inputClass} value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} />
            </Field>
            <Field label="Instructions (Markdown)">
              <textarea className={clsx(inputClass, "min-h-36 font-mono text-[12.5px]")} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" disabled={!form.name.trim() || !form.body.trim()} onClick={save}>
                Save skill
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {(data?.skills ?? []).map((s) => (
            <div key={s.id} className={clsx(card, "p-3.5")}>
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{s.name}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{s.description}</span>
                </span>
                <Badge tone={s.source === "custom" ? "accent" : "mute"}>{s.source}</Badge>
              </button>
              {open === s.id && (
                <div className="mt-3 space-y-2 border-t border-line pt-3 text-[12.5px] text-mute">
                  <p>
                    <span className="text-faint">Loads on:</span> {s.triggers.join(", ") || "manual only"}
                  </p>
                  <p>
                    <span className="text-faint">Tools:</span> {s.tools.join(", ") || "none"}
                  </p>
                  <p className="font-mono text-[11px] text-faint">{s.path}</p>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-app p-2.5 font-mono text-[11.5px] whitespace-pre-wrap">{s.body}</pre>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setForm({ name: s.name, description: s.description, triggers: s.triggers.join(", "), tools: s.tools.join(", "), output: s.output, body: s.body })}>
                      {s.source === "custom" ? "Edit" : "Customise a copy"}
                    </Button>
                    {s.source === "custom" && (
                      <Button size="sm" variant="danger" onClick={() => remove(s)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
      <Section title="Data files agents can analyse">
        <div className={clsx(card, "flex flex-wrap items-center gap-3 p-3.5")}>
          <span className="min-w-0 flex-1 text-[13px] text-mute">{(files.data?.files ?? []).map((f) => `${f.name} (${f.where === "samples" ? "synthetic sample" : "uploaded"})`).join(" · ") || "No files yet."}</span>
          <label className="inline-flex h-8 cursor-pointer items-center rounded-full bg-raised-2 px-3.5 text-[13px] font-medium hover:bg-[#2f2f2f]">
            Upload CSV
            <input type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
        </div>
      </Section>
      <Section title={`Tools (${data?.tools.length ?? 0})`}>
        {groups.map((g) => (
          <div key={g} className={clsx(card, "mb-2 overflow-hidden")}>
            <div className="bg-raised-2 px-3.5 py-1.5 text-[12px] font-medium text-mute">{g}</div>
            {(data?.tools ?? []).filter((t) => t.group === g).map((t: ToolInfo) => (
              <div key={t.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3.5 py-2">
                <code className="w-44 shrink-0 font-mono text-[12px] text-ink">{t.name}</code>
                <span className="min-w-0 flex-1 text-[12.5px] text-mute">{t.description}</span>
                <Badge tone={t.risk === "external" ? "warn" : t.risk === "local" ? "accent" : "mute"}>{t.risk === "external" ? "needs approval" : t.risk === "local" ? "local change" : "read only"}</Badge>
                <span title={t.note}>
                  <Badge tone={t.live ? "ok" : "warn"}>{t.live ? "live" : "simulated / off"}</Badge>
                </span>
              </div>
            ))}
          </div>
        ))}
      </Section>
    </>
  );
}

// ── integrations ────────────────────────────────────────────────────────

function IntegrationCard({ info }: { info: IntegrationInfo }) {
  const { toast, setPanel } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast(error instanceof Error ? error.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const shown = result ?? info.lastTest ?? null;
  return (
    <div className={clsx(card, "p-4")}>
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-medium">{info.name}</span>
        <Badge tone={info.state === "live" ? "ok" : "warn"}>{info.state === "live" ? "live" : "not connected · simulated"}</Badge>
        {info.docsUrl && (
          <a href={info.docsUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-[12px] text-mute hover:text-ink">
            Get credentials <ArrowUpRight size={12} />
          </a>
        )}
      </div>
      <p className="mt-1 text-[13px] text-mute">{info.description}</p>
      <p className="mt-1.5 text-[12.5px] leading-snug text-ink">{info.detail}</p>
      <p className="mt-1.5 font-mono text-[11.5px] text-faint">{info.tools.join(" · ")}</p>
      {info.fields.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {info.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.set ? " (saved)" : ""}`} hint={f.hint}>
              <input className={inputClass} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.set ? "•••••••• saved; type to replace" : f.key} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {info.fields.length > 0 && (
          <Button size="sm" variant="primary" disabled={busy || !Object.values(values).some((v) => v.trim())} onClick={() => run(async () => (await api.saveIntegration(info.id, values), setValues({}), toast("Saved, encrypted on this machine.")))}>
            Save
          </Button>
        )}
        {info.id === "mcp" && (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => run(async () => (await api.saveIntegration("mcp", {}, "deepwiki"), toast("DeepWiki added. Switch it on for an agent in its Details → Connections.")))}>
              Add DeepWiki (free)
            </Button>
            <Button size="sm" onClick={() => setPanel({ kind: "connections" })}>
              Add a server by URL
            </Button>
          </>
        )}
        {info.id === "composio" && (
          <Button size="sm" onClick={() => setPanel({ kind: "connections" })}>
            Open Connections
          </Button>
        )}
        {info.id !== "composio" && (
          <Button size="sm" disabled={busy} onClick={() => run(async () => setResult(await api.testIntegration(info.id)))}>
            {busy ? "Testing…" : "Test connection"}
          </Button>
        )}
        {shown && <span className={clsx("min-w-0 flex-1 text-[12.5px]", shown.ok ? "text-ok" : "text-danger")}>{shown.message}</span>}
      </div>
    </div>
  );
}

function IntegrationsPage() {
  const { state } = useApp();
  const { data } = useLoad(() => api.integrations(), [state.versions.integrations, state.connectionsVersion]);
  return (
    <>
      <p className={clsx(card, "mb-4 px-4 py-3 text-[13px] leading-relaxed text-mute")}>
        <strong className="text-ink">Live</strong> means the action reaches the real service. <strong className="text-ink">Simulated</strong> means the action still goes through approval, but instead of being sent it is written to the{" "}
        <code className="font-mono text-[12px]">data/outbox</code> folder and every message and log entry says SIMULATED. Credentials are stored encrypted on this machine and are never shown again.
      </p>
      <div className="grid gap-3 xl:grid-cols-2">{(data?.integrations ?? []).map((i) => <IntegrationCard key={i.id} info={i} />)}</div>
    </>
  );
}

// ── models ──────────────────────────────────────────────────────────────

function UsageTable({ title, rows, name }: { title: string; rows: UsageRow[]; name?: (key: string) => string }) {
  return (
    <div className={clsx(card, "overflow-hidden")}>
      <div className="bg-raised-2 px-3.5 py-1.5 text-[12px] font-medium text-mute">{title}</div>
      {rows.length === 0 && <p className="px-3.5 py-3 text-[13px] text-mute">No model calls yet.</p>}
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 border-t border-line px-3.5 py-1.5 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate">{name ? name(r.key) : r.key}</span>
          <span className="text-mute">{r.calls} calls</span>
          <span className="w-24 text-right text-mute">{formatTokens(r.input + r.output)} tok</span>
          <span className="w-16 text-right">{formatCost(r.costUsd) ?? "$0"}</span>
        </div>
      ))}
    </div>
  );
}

function ModelsPage() {
  const { state, toast } = useApp();
  const botName = useBotName();
  const { data } = useLoad<{ providers: ProviderInfo[]; usage: UsageSummary; models: ModelOption[]; routing: Record<string, string | null> }>(() => api.providers(), [state.bots]);
  const setMode = async (id: string, patch: { modelMode?: "fixed" | "auto"; model?: string; fallbackModels?: string[] }) => {
    try {
      await api.updateBot(id, patch);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't update.");
    }
  };
  const available = (data?.models ?? []).filter((m) => m.available !== false);
  return (
    <>
      {state.status?.mock && (
        <p className="mb-4 rounded-2xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
          Mock mode: no provider key is set, so agents run on a scripted model that calls real tools but cannot write. Add a free key (Groq or Google Gemini) to the <code className="font-mono">.env</code> file and restart.
        </p>
      )}
      <Section title="Providers">
        <div className={clsx(card, "overflow-hidden")}>
          {(data?.providers ?? []).map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3.5 py-2.5 first:border-t-0">
              <span className="w-40 text-[14px] font-medium">{p.name}</span>
              <Badge tone={p.configured ? "ok" : "mute"}>{p.configured ? "configured" : "no key"}</Badge>
              <Badge tone="mute">{p.local ? "local" : "hosted"}</Badge>
              {p.free && <Badge tone="accent">free tier</Badge>}
              <code className="font-mono text-[12px] text-mute">{p.envVar}</code>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{p.configured ? `${p.models.length} models` : ""}</span>
              <a href={p.keysUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-mute hover:text-ink">
                {p.local ? "Install" : "Get a key"} <ArrowUpRight size={12} />
              </a>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Task-based routing and fallback">
        <div className={clsx(card, "space-y-1.5 p-4 text-[13px] text-mute")}>
          <p>Agents on <strong className="text-ink">Auto</strong> get a model picked for each task:</p>
          {(["fast", "balanced", "strong"] as const).map((tier) => (
            <p key={tier}>
              <span className="inline-block w-24 text-ink capitalize">{tier}</span>
              <code className="font-mono text-[12px]">{data?.routing[tier] ?? "mock model"}</code>
              <span className="ml-2 text-faint">{tier === "fast" ? "short questions, quick answers" : tier === "balanced" ? "research, analysis, reviews" : "planning and the final consolidation"}</span>
            </p>
          ))}
          <p className="pt-1.5">If a model call fails (rate limit, outage, retired model), the same turn is retried on the agent&apos;s own fallbacks, then on the same tier of every other configured provider. Each fallback is recorded in the audit log and on the message.</p>
        </div>
      </Section>
      <Section title="Per-agent models">
        <div className={clsx(card, "overflow-x-auto")}>
          <table className="w-full">
            <thead>
              <tr>
                {["Agent", "Mode", "Model", "First fallback"].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.bots.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className={td}>{b.name}</td>
                  <td className={td}>
                    <select className="rounded-lg bg-raised-2 px-2 py-1 text-[12.5px]" value={b.modelMode} onChange={(e) => setMode(b.id, { modelMode: e.target.value as "fixed" | "auto" })}>
                      <option value="auto">Auto (by task)</option>
                      <option value="fixed">Fixed</option>
                    </select>
                  </td>
                  <td className={td}>
                    <select className="max-w-[240px] rounded-lg bg-raised-2 px-2 py-1 text-[12.5px] disabled:opacity-40" disabled={b.modelMode === "auto"} value={b.model} onChange={(e) => setMode(b.id, { model: e.target.value })}>
                      {!available.some((m) => m.id === b.model) && <option value={b.model}>{b.model}</option>}
                      {available.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={td}>
                    <select className="max-w-[240px] rounded-lg bg-raised-2 px-2 py-1 text-[12.5px]" value={b.fallbackModels[0] ?? ""} onChange={(e) => setMode(b.id, { fallbackModels: e.target.value ? [e.target.value] : [] })}>
                      <option value="">Automatic</option>
                      {available.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={`Tokens and cost · total ${formatTokens((data?.usage.total.input ?? 0) + (data?.usage.total.output ?? 0))} tokens · ${formatCost(data?.usage.total.costUsd ?? 0) ?? "$0"}`}>
        <div className="grid gap-3 lg:grid-cols-3">
          <UsageTable title="By model" rows={data?.usage.byModel ?? []} />
          <UsageTable title="By agent" rows={data?.usage.byBot ?? []} name={(k) => (k === "none" ? "Planner and factory" : botName(k))} />
          <UsageTable title="By day" rows={data?.usage.byDay ?? []} />
        </div>
        <p className="mt-2 text-[12px] text-faint">Cost uses each provider&apos;s list price per million tokens. Free-tier models count as $0. Mock-mode replies are not counted.</p>
      </Section>
    </>
  );
}

// ── workflows ───────────────────────────────────────────────────────────

const RUN_TONE: Record<string, "ok" | "warn" | "danger" | "mute" | "accent"> = { done: "ok", failed: "danger", cancelled: "mute", running: "accent" };

function WorkflowsPage() {
  const { state, toast, setPage } = useApp();
  const { data } = useLoad(() => api.workflows(), [state.versions.workflows]);
  const artifacts = useLoad(() => api.artifacts(), [state.versions.workflows]);
  const rooms = state.rooms.filter((r) => r.memberIds.some((id) => state.bots.find((b) => b.id === id)?.role === "chief"));
  const [form, setForm] = useState({ name: "", instruction: "", conversationId: "", schedule: "daily 09:00" });
  const room = form.conversationId || (rooms[0] ? `room:${rooms[0].id}` : "");
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (error) {
      toast(error instanceof Error ? error.message : "That didn't work.");
    }
  };
  const create = () => run(async () => (await api.createWorkflow({ ...form, conversationId: room }), setForm({ name: "", instruction: "", conversationId: "", schedule: "daily 09:00" })), "Workflow created.");
  const where = useConversationName();
  return (
    <>
      <Section title="New workflow">
        <div className={clsx(card, "space-y-3 p-4")}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Competitor watch" />
            </Field>
            <Field label="Room (needs a Chief of Staff)">
              <select className={inputClass} value={room} onChange={(e) => setForm({ ...form, conversationId: e.target.value })}>
                {rooms.map((r) => (
                  <option key={r.id} value={`room:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Schedule" hint='"every 30 minutes", "daily 09:00", "weekly monday 10:00", "manual"'>
              <input className={inputClass} value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} />
            </Field>
          </div>
          <Field label="Instruction">
            <textarea className={clsx(inputClass, "min-h-20")} value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} placeholder="Check what our main competitors published or changed this week and write a short report with sources." />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" disabled={!form.name.trim() || form.instruction.trim().length < 5 || !room} onClick={create}>
              Create workflow
            </Button>
          </div>
        </div>
      </Section>
      <Section title={`Workflows (${data?.workflows.length ?? 0})`}>
        {data?.workflows.length === 0 && <Empty>No workflows yet.</Empty>}
        <div className="space-y-2">
          {(data?.workflows ?? []).map((w: WorkflowRow) => (
            <div key={w.id} className={clsx(card, "p-4")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-medium">{w.name}</span>
                <Badge tone={w.status === "active" ? "ok" : "mute"}>{w.status}</Badge>
                {w.lastStatus && <Badge tone={RUN_TONE[w.lastStatus] ?? "mute"}>last run {w.lastStatus}</Badge>}
                {w.failures > 0 && <Badge tone="danger">{w.failures} failed</Badge>}
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => run(() => api.runWorkflow(w.id), "Run started. Watch it in the room or the task dashboard.")}>
                    Run now
                  </Button>
                  <Button size="sm" onClick={() => run(() => api.updateWorkflow(w.id, { status: w.status === "active" ? "paused" : "active" }))}>
                    {w.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => window.confirm(`Delete "${w.name}"?`) && run(() => api.deleteWorkflow(w.id))}>
                    Delete
                  </Button>
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-mute">{w.instruction}</p>
              <p className="mt-1.5 text-[12px] text-faint">
                {w.scheduleText} · in {where(w.conversationId)} · {w.nextRunAt ? `next run ${new Date(w.nextRunAt).toLocaleString()}` : w.status === "paused" ? "paused" : "runs only when you press Run now"}
                {w.lastRunAt ? ` · last run ${new Date(w.lastRunAt).toLocaleString()}` : ""}
              </p>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Run history">
        {(data?.runs.length ?? 0) === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <div className={clsx(card, "overflow-x-auto")}>
            <table className="w-full">
              <thead>
                <tr>
                  {["Started", "Workflow", "Trigger", "Status", "Result", ""].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.runs ?? []).map((r: WorkflowRun) => {
                  const artifact = artifacts.data?.artifacts.find((a) => a.id === r.artifactId);
                  return (
                    <tr key={r.id} className="border-t border-line">
                      <td className={clsx(td, "whitespace-nowrap text-mute")}>{new Date(r.startedAt).toLocaleString()}</td>
                      <td className={td}>{data?.workflows.find((w) => w.id === r.workflowId)?.name ?? "deleted"}</td>
                      <td className={td}>{r.trigger}</td>
                      <td className={td}>
                        <Badge tone={RUN_TONE[r.status] ?? "mute"}>{r.status}</Badge>
                      </td>
                      <td className={clsx(td, r.error ? "text-danger" : "text-mute")}>{r.error ?? r.summary ?? ""}</td>
                      <td className={clsx(td, "whitespace-nowrap")}>
                        {artifact && <ReportButton artifact={artifact} />}
                        {r.planId && (
                          <button className="ml-2 text-[12.5px] text-mute underline hover:text-ink" onClick={() => setPage("tasks")}>
                            Tasks
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function ReportButton({ artifact }: { artifact: ArtifactRow }) {
  const { showReport } = useApp();
  if (!artifact.file.endsWith(".md"))
    return (
      <a className="text-[12.5px] text-[#8db4ff] underline" href={artifact.url} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    );
  return (
    <button className="text-[12.5px] text-[#8db4ff] underline" onClick={() => showReport(artifact.title, artifact.url)}>
      Report
    </button>
  );
}

// ── history ─────────────────────────────────────────────────────────────

function HistoryPage() {
  const { state, dispatch, open } = useApp();
  const where = useConversationName();
  const botName = useBotName();
  const artifacts = useLoad(() => api.artifacts(), [Object.keys(state.plans).length]);
  const audit = useLoad(() => api.approvals(), [state.versions.approvals]);
  useEffect(() => {
    api.plans().then((d) => d.plans.forEach((plan) => dispatch({ type: "event", event: { type: "plan", plan } }))).catch(() => {});
  }, [dispatch]);
  const plans = Object.values(state.plans).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tone = (s: string) => (s === "done" ? "ok" : s === "failed" ? "danger" : s === "cancelled" ? "mute" : "warn");
  return (
    <>
      <Section title={`Plans (${plans.length})`}>
        {plans.length === 0 ? (
          <Empty>No plans have run yet.</Empty>
        ) : (
          <div className={clsx(card, "overflow-x-auto")}>
            <table className="w-full">
              <thead>
                <tr>
                  {["Started", "Goal", "Where", "Status", "Tasks", "Tokens", ""].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const artifact = artifacts.data?.artifacts.find((a) => a.id === p.artifactId);
                  return (
                    <tr key={p.id} className="border-t border-line">
                      <td className={clsx(td, "whitespace-nowrap text-mute")}>{new Date(p.createdAt).toLocaleString()}</td>
                      <td className={td}>
                        {p.goal} {p.simulated && <Badge tone="warn">mock</Badge>} {p.workflowId && <Badge tone="accent">workflow</Badge>}
                      </td>
                      <td className={td}>
                        <button className="underline decoration-line-strong hover:text-ink" onClick={() => open(p.conversationId)}>
                          {where(p.conversationId)}
                        </button>
                      </td>
                      <td className={td}>
                        <Badge tone={tone(p.status)}>{p.status}</Badge>
                      </td>
                      <td className={clsx(td, "whitespace-nowrap text-mute")}>
                        {p.tasks.filter((t) => t.status === "done").length}/{p.tasks.length}
                      </td>
                      <td className={clsx(td, "whitespace-nowrap text-mute")}>{formatTokens(p.usage.input + p.usage.output)}</td>
                      <td className={td}>{artifact && <ReportButton artifact={artifact} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title={`Deliverables (${artifacts.data?.artifacts.length ?? 0})`}>
        {(artifacts.data?.artifacts.length ?? 0) === 0 ? (
          <Empty>Reports and charts appear here.</Empty>
        ) : (
          <div className={clsx(card, "max-h-[360px] overflow-auto")}>
            {(artifacts.data?.artifacts ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[13px] first:border-t-0">
                <Badge tone="mute">{a.kind}</Badge>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                {a.simulated && <Badge tone="warn">mock</Badge>}
                <span className="text-[12px] text-faint">{botName(a.botId)}</span>
                <span className="text-[12px] text-faint">{new Date(a.createdAt).toLocaleString()}</span>
                <ReportButton artifact={a} />
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Recorded actions">
        <AuditTable entries={audit.data?.audit ?? []} />
      </Section>
    </>
  );
}

// ── shell ───────────────────────────────────────────────────────────────

export function Workspace({ page }: { page: WorkspacePage }) {
  const { setPage, state, open } = useApp();
  const { title, sub } = TITLES[page];
  const back = () => {
    setPage(null);
    window.history.replaceState(null, "", state.active ? `#${state.active}` : window.location.pathname);
    if (state.active) open(state.active);
  };
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
        <IconButton label="Back to chat" onClick={back} className="bg-raised">
          <ArrowLeft size={17} />
        </IconButton>
        <div className="min-w-0">
          <h1 className="truncate text-[16px] font-semibold">{title}</h1>
          <p className="truncate text-[12.5px] text-mute">{sub}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-[1100px]">
          {page === "tasks" && <TasksPage />}
          {page === "approvals" && <ApprovalsPage />}
          {page === "memory" && <MemoryPage />}
          {page === "skills" && <SkillsPage />}
          {page === "integrations" && <IntegrationsPage />}
          {page === "models" && <ModelsPage />}
          {page === "workflows" && <WorkflowsPage />}
          {page === "history" && <HistoryPage />}
        </div>
      </div>
    </div>
  );
}

/** A saved Markdown report, rendered in a sheet over the app. */
export function ReportViewer({ title, path, onClose }: { title: string; path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(path)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("The file is missing."))))
      .then((t) => setText(t.replace(/^<!--[\s\S]*?-->\s*/, "")))
      .catch((e: Error) => setText(`Couldn't load the report: ${e.message}`));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative flex max-h-full w-full max-w-[860px] flex-col rounded-2xl bg-side shadow-pop ring-1 ring-line-strong">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
          <a href={path} download className="text-[12.5px] text-mute underline hover:text-ink">
            Download .md
          </a>
          <IconButton label="Close" onClick={onClose} className="bg-raised">
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{text === null ? <p className="text-mute">Loading…</p> : <Markdown text={text} />}</div>
      </div>
    </div>
  );
}
