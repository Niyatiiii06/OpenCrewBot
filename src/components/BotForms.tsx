"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import type { AgentDraft, Bot, BotInput, Skill, ToolPolicy } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { ModelPicker } from "./ModelPicker";
import { Button, Drawer, Field, Mascot, Segmented, Toggle, inputClass } from "./ui";

export const BOT_COLORS = ["#3b82f6", "#f59e0b", "#ec4899", "#22c55e", "#8b5cf6", "#14b8a6", "#ef4444", "#eab308", "#f4f4f4"];

function blankBot(defaultModel: string): BotInput {
  return {
    name: "",
    title: "",
    description: "",
    instructions: "",
    emoji: "",
    color: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)],
    model: defaultModel,
    tools: { webSearch: true, memory: true, codeMode: false, browser: false, askUser: true, collaboration: true, dataAnalysis: false, github: false, email: false, slack: false, notion: false, artifacts: true },
    approval: "ask",
    pinned: false,
    role: "member",
    skills: [],
    outputFormat: "",
    modelMode: "auto",
    fallbackModels: [],
    toolPolicy: {},
    limits: { maxActionsPerRun: 3, allowedEmailDomains: [], allowedRepos: [] },
  };
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Color">
      {BOT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Color ${c}`}
          onClick={() => onChange(c)}
          className={clsx(
            "flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110",
            value === c && "ring-2 ring-white ring-offset-2 ring-offset-side",
          )}
          style={{ background: c }}
        >
          {value === c && <Check size={14} className={c === "#f4f4f4" ? "text-black" : "text-white"} />}
        </button>
      ))}
    </div>
  );
}

/** Create or edit a bot. In edit mode the save bar appears only once something changes. */
/** Tools that act outside the app. Each can be set to always ask, never ask, or be blocked. */
const EXTERNAL_TOOLS: { name: string; label: string; needs: keyof BotInput["tools"] }[] = [
  { name: "send_email", label: "Send email", needs: "email" },
  { name: "slack_post", label: "Post to Slack", needs: "slack" },
  { name: "notion_create_page", label: "Create Notion page", needs: "notion" },
  { name: "github_create_issue", label: "Open GitHub issue", needs: "github" },
];

const csv = (text: string) => text.split(",").map((t) => t.trim()).filter(Boolean);

/** Create or edit an agent. In edit mode the save bar appears only once something changes. */
export function BotForm({ bot, onDone }: { bot?: Bot; onDone?: (bot: Bot) => void }) {
  const { state, open, toast } = useApp();
  const defaultModel = state.models.find((m) => m.available !== false)?.id ?? state.models[0]?.id ?? "groq/openai/gpt-oss-120b";
  const [initial, setInitial] = useState<BotInput>(() => (bot ? { ...bot } : blankBot(defaultModel)));
  const [form, setForm] = useState<BotInput>(initial);
  const [saving, setSaving] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  // Agent factory: describe the agent in plain language and get a filled-in form to review.
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    api.skills().then((d) => setSkills(d.skills)).catch(() => {});
  }, []);
  const makeDraft = async () => {
    setDrafting(true);
    try {
      const { draft: d } = await api.draftAgent(description);
      setDraft(d);
      setForm((f) => ({ ...f, ...d.input, color: d.input.color || f.color }));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't draft the agent.");
    } finally {
      setDrafting(false);
    }
  };
  const limits = form.limits ?? { maxActionsPerRun: 3, allowedEmailDomains: [], allowedRepos: [] };
  const policy = form.toolPolicy ?? {};
  const keys = state.status?.keys;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const set = <K extends keyof BotInput>(k: K, v: BotInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setTool = (k: keyof BotInput["tools"], v: boolean) => setForm((f) => ({ ...f, tools: { ...f.tools, [k]: v } }));

  const save = async () => {
    setSaving(true);
    try {
      if (bot) {
        const { bot: saved } = await api.updateBot(bot.id, form);
        setInitial({ ...saved });
        setForm({ ...saved });
        toast("Saved. Changes apply from the next reply.");
        onDone?.(saved);
      } else {
        const { bot: created } = draft ? await api.createFromDraft(form, draft.memorySeed) : await api.createBot(form);
        open(`dm:${created.id}`);
        onDone?.(created);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!bot || !window.confirm(`Delete ${bot.name}? Its chat and MEMORY.md are deleted too.`)) return;
    try {
      await api.deleteBot(bot.id);
      open(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete.");
    }
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-5">
        {!bot && (
          <div className="rounded-2xl bg-accent-soft p-3.5 ring-1 ring-accent/40">
            <span className="block text-[13px] font-medium">Describe the agent in plain language</span>
            <textarea
              className={clsx(inputClass, "mt-2 min-h-20 leading-relaxed")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A scholarship researcher who finds funding options for Indian students going to the UK, cites every source, and asks before emailing anyone."
            />
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="primary" disabled={drafting || description.trim().length < 10} onClick={makeDraft}>
                {drafting ? "Drafting…" : draft ? "Draft again" : "Draft agent"}
              </Button>
              <span className="text-[12px] text-mute">Fills in the form below. Review it, then create.</span>
            </div>
            {draft && (
              <p className="mt-2 text-[12.5px] leading-snug text-mute">
                <strong className="text-ink">Drafted by {draft.draftedBy === "model" ? "a model" : "built-in rules (no model key)"}.</strong> {draft.rationale}
              </p>
            )}
          </div>
        )}
        {!bot && (
          <div className="flex flex-col items-center gap-4 pt-1">
            <Mascot color={form.color} size={72} />
            <ColorPicker value={form.color} onChange={(c) => set("color", c)} />
          </div>
        )}
        {bot && (
          <Field label="Color">
            <ColorPicker value={form.color} onChange={(c) => set("color", c)} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputClass} value={form.name} maxLength={40} onChange={(e) => set("name", e.target.value)} placeholder="Scout" />
          </Field>
          <Field label="Role">
            <input className={inputClass} value={form.title} maxLength={40} onChange={(e) => set("title", e.target.value)} placeholder="Research" />
          </Field>
        </div>
        {bot && (
          <Field label="Handle" hint="For @mentions in rooms.">
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[14px] text-faint">@</span>
              <input
                className={clsx(inputClass, "pl-7")}
                value={form.handle ?? bot.handle}
                onChange={(e) => set("handle", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              />
            </div>
          </Field>
        )}
        <Field label="What it's for" hint="One line. Rooms use it to decide who answers.">
          <input
            className={inputClass}
            value={form.description}
            maxLength={200}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Finds things out on the web and comes back with sourced answers."
          />
        </Field>
        <Field label="Instructions" hint="How it should work and talk. Part of its system prompt.">
          <textarea
            className={clsx(inputClass, "min-h-28 resize-y leading-relaxed")}
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="Research before answering anything time-sensitive. Cite the URLs you used."
          />
        </Field>

        {/* Not a <label>: the picker holds buttons and its own search field. */}
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Model</span>
          <Segmented
            value={form.modelMode ?? "fixed"}
            onChange={(v) => set("modelMode", v)}
            options={[
              { value: "auto", label: "Auto", hint: "Picks fast, balanced or strong per task." },
              { value: "fixed", label: "Fixed", hint: "Always the model below." },
            ]}
          />
          {form.modelMode === "fixed" && (
            <div className="mt-2">
              <ModelPicker value={form.model} onChange={(id) => set("model", id)} />
            </div>
          )}
          <span className="mt-1.5 block text-[12px] leading-snug text-faint">
            {state.status?.mock ? "Mock mode: replies come from a scripted model until a provider key is set (Models page)." : "If the model fails, the turn falls back to another model automatically."}
          </span>
        </div>

        <Field label="Role in the team">
          <Segmented
            value={form.role ?? "member"}
            onChange={(v) => set("role", v)}
            options={[
              { value: "member", label: "Specialist", hint: "Does the tasks it is given." },
              { value: "chief", label: "Chief of Staff", hint: "Plans, delegates, consolidates." },
            ]}
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Skills this agent always carries</span>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => {
              const on = (form.skills ?? []).includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  title={s.description}
                  onClick={() => set("skills", on ? (form.skills ?? []).filter((x) => x !== s.id) : [...(form.skills ?? []), s.id])}
                  className={clsx("rounded-full px-2.5 py-1 text-[12.5px] ring-1 transition-colors", on ? "bg-accent-soft text-ink ring-accent/60" : "bg-raised text-mute ring-line hover:text-ink")}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          <span className="mt-1.5 block text-[12px] leading-snug text-faint">Other skills load on their own when a task matches them.</span>
        </div>

        <Field label="Output format" hint="How its answers should be shaped.">
          <input className={inputClass} value={form.outputFormat ?? ""} onChange={(e) => set("outputFormat", e.target.value)} placeholder="Summary first, then a table, then sources." />
        </Field>

        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Tools</span>
          <div className="divide-y divide-line rounded-2xl bg-raised px-4">
            <Toggle
              label="Web search"
              hint={keys?.tavily ? "Tavily search, page reading and site crawls." : "Search and read pages with no key (DuckDuckGo). Add TAVILY_API_KEY for richer results."}
              checked={form.tools.webSearch}
              onChange={(v) => setTool("webSearch", v)}
            />
            <Toggle label="Memory" hint="Reads and updates its own MEMORY.md." checked={form.tools.memory} onChange={(v) => setTool("memory", v)} />
            <Toggle
              label="Code mode"
              hint="Writes one TypeScript function that calls several tools at once, in a sandbox."
              checked={form.tools.codeMode}
              onChange={(v) => setTool("codeMode", v)}
            />
            <Toggle
              label="Browser"
              hint={keys?.browserbase ? "A Browserbase cloud browser you can watch live." : "Browserbase. Needs BROWSERBASE_API_KEY."}
              checked={form.tools.browser}
              onChange={(v) => setTool("browser", v)}
            />
            <Toggle label="Ask me questions" hint="Can pause and ask you with a card in chat." checked={form.tools.askUser} onChange={(v) => setTool("askUser", v)} />
            <Toggle label="Teamwork" hint="Ask, delegate to, verify with and challenge teammates; share findings in a room." checked={Boolean(form.tools.collaboration)} onChange={(v) => setTool("collaboration", v)} />
            <Toggle label="Data analysis" hint="Reads spreadsheets, calculates, draws charts." checked={Boolean(form.tools.dataAnalysis)} onChange={(v) => setTool("dataAnalysis", v)} />
            <Toggle label="Deliverables" hint="Saves reports and drafts as files." checked={Boolean(form.tools.artifacts)} onChange={(v) => setTool("artifacts", v)} />
            <Toggle label="GitHub" hint="Inspects repositories and reads files. Opening an issue needs approval." checked={Boolean(form.tools.github)} onChange={(v) => setTool("github", v)} />
            <Toggle label="Email" hint="Sends email through Gmail. Needs approval." checked={Boolean(form.tools.email)} onChange={(v) => setTool("email", v)} />
            <Toggle label="Slack" hint="Posts to a Slack channel. Needs approval." checked={Boolean(form.tools.slack)} onChange={(v) => setTool("slack", v)} />
            <Toggle label="Notion" hint="Creates Notion pages. Needs approval." checked={Boolean(form.tools.notion)} onChange={(v) => setTool("notion", v)} />
          </div>
        </div>

        <Field label="Approval">
          <Segmented
            value={form.approval}
            onChange={(v) => set("approval", v)}
            options={[
              { value: "ask", label: "Ask first", hint: "Every outside action waits for you." },
              { value: "controlled", label: "Controlled", hint: "Pre-approved actions run, within limits." },
              { value: "full", label: "Full access", hint: "Runs permitted tools on its own." },
            ]}
          />
        </Field>

        {form.approval === "controlled" && (
          <div className="space-y-3 rounded-2xl bg-raised p-4">
            <span className="block text-[12.5px] font-medium text-mute">What is pre-approved (everything else still asks)</span>
            <Field label="Email may go to these domains without asking" hint="Comma-separated, e.g. meetuniversity.com. Empty = always ask.">
              <input className={inputClass} defaultValue={limits.allowedEmailDomains.join(", ")} onBlur={(e) => set("limits", { ...limits, allowedEmailDomains: csv(e.target.value) })} />
            </Field>
            <Field label="GitHub issues may be opened in these repositories without asking" hint="owner/name, comma-separated. Empty = always ask.">
              <input className={inputClass} defaultValue={limits.allowedRepos.join(", ")} onBlur={(e) => set("limits", { ...limits, allowedRepos: csv(e.target.value) })} />
            </Field>
            <Field label="Most outside actions per run" hint="After this many, the agent has to ask again.">
              <input className={inputClass} type="number" min={0} max={20} value={limits.maxActionsPerRun} onChange={(e) => set("limits", { ...limits, maxActionsPerRun: Math.max(0, Number(e.target.value) || 0) })} />
            </Field>
          </div>
        )}

        {EXTERNAL_TOOLS.some((t) => form.tools[t.needs]) && (
          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Tool-level permissions</span>
            <div className="divide-y divide-line rounded-2xl bg-raised px-4">
              {EXTERNAL_TOOLS.filter((t) => form.tools[t.needs]).map((t) => (
                <div key={t.name} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-[14px]">{t.label}</span>
                  <select
                    className="rounded-lg bg-raised-2 px-2 py-1 text-[12.5px]"
                    value={policy[t.name] ?? "level"}
                    onChange={(e) => {
                      const next = { ...policy };
                      if (e.target.value === "level") delete next[t.name];
                      else next[t.name] = e.target.value as ToolPolicy;
                      set("toolPolicy", next);
                    }}
                  >
                    <option value="level">Follow the level above</option>
                    <option value="ask">Always ask</option>
                    <option value="allow">Never ask</option>
                    <option value="deny">Blocked</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {bot && (
          <div className="pt-2">
            <Button variant="danger" size="sm" onClick={remove}>
              Delete bot
            </Button>
          </div>
        )}
      </div>

      {(dirty || !bot) && (
        <div className="sticky bottom-0 -mx-5 mt-5 flex items-center justify-end gap-2 border-t border-line bg-side px-5 py-3">
          {bot && (
            <Button variant="ghost" onClick={() => setForm(initial)}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={saving || !form.name.trim() || (bot && !dirty)}>
            {saving ? "Saving…" : bot ? "Save changes" : "Create agent"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function NewBotDrawer({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="New agent" onClose={onClose}>
      <BotForm onDone={onClose} />
    </Drawer>
  );
}

/** The bot's MEMORY.md, editable, refreshed live when the bot writes to it. */
export function MemoryEditor({ bot }: { bot: Bot }) {
  const { state, toast } = useApp();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [meta, setMeta] = useState<{ path: string; limit: { lines: number; bytes: number } } | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = content !== null && content !== saved;
  const version = state.memoryVersion[bot.id] ?? 0;

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Load, and reload when the bot writes to its memory unless you have unsaved edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api
      .getMemory(bot.id)
      .then((data) => {
        if (cancelled) return;
        setSaved(data.content);
        setContent(data.content);
        setMeta({ path: data.path, limit: data.limit });
      })
      .catch((error) => toast(error instanceof Error ? error.message : "Couldn't load memory."));
    return () => {
      cancelled = true;
    };
  }, [bot.id, version, toast]);

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    try {
      const data = await api.saveMemory(bot.id, content);
      setSaved(data.content);
      setContent(data.content);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save memory.");
    } finally {
      setSaving(false);
    }
  };

  const lines = content ? content.trimEnd().split("\n").length : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-[13px] leading-relaxed text-mute">
        {bot.name} reads this at the start of every turn and keeps it up to date. It&apos;s plain Markdown, so edit away.
      </p>
      {!bot.tools.memory && (
        <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">Memory is off for this bot, so this file isn&apos;t loaded.</p>
      )}
      <textarea
        value={content ?? ""}
        onChange={(e) => setContent(e.target.value)}
        disabled={content === null}
        spellCheck={false}
        aria-label="MEMORY.md"
        className={clsx(inputClass, "h-[50vh] min-h-[240px] resize-y rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed")}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] text-faint" title={meta?.path}>
          MEMORY.md · {lines} {lines === 1 ? "line" : "lines"}
          {meta && lines > meta.limit.lines ? ` · first ${meta.limit.lines} load` : ""}
        </span>
        <span className="flex shrink-0 gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setContent(saved)}>
              Revert
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </span>
      </div>
    </div>
  );
}
