// The Chief of Staff's planning: turn one instruction into tasks, pick the best
// agent for each, and set the order. A model writes the plan when one is
// available. If it is not, or its answer is unusable, a rule-based planner
// matches the request to capabilities so the system still works (mock mode).
import { z } from "zod";
import type { Bot, BotTools, Plan, Room, TaskKind } from "@/lib/shared/types";
import { listDataFiles } from "./data-analysis";
import { complete, parseJson } from "./llm";
import { sharedMemoryForPrompt } from "./memory-files";
import { listSkills, scoreSkill, selectSkills } from "./skills";

export interface PlannedTask {
  ref: string;
  title: string;
  description: string;
  agentId: string;
  /** Refs of tasks that must finish first. */
  dependsOn: string[];
  skills: string[];
  capability: string;
  kind: TaskKind;
  needsApproval: boolean;
}

export interface PlanDraft {
  /** True when the request is a simple question the Chief should just answer. */
  direct: boolean;
  goal: string;
  tasks: PlannedTask[];
  plannedBy: "model" | "rules";
  model?: string;
  /** Descriptions of agents to create because nobody on the team can do the work. */
  newAgents: string[];
  notes: string[];
}

type ToolKey = keyof BotTools;

// ── choosing an agent ───────────────────────────────────────────────────

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);

/** How well an agent fits a piece of work: the tool it needs, its skills, and its role. */
export function scoreAgent(bot: Bot, need: { tool?: ToolKey; skills?: string[]; text: string }): number {
  let score = 0;
  if (need.tool) score += bot.tools[need.tool] ? 6 : -6;
  for (const id of need.skills ?? []) if (bot.skills.includes(id)) score += 4;
  const mine = words(`${bot.title} ${bot.description} ${bot.name}`);
  for (const w of words(need.text)) if (mine.has(w)) score += 1;
  if (bot.role === "chief") score -= 3;
  return score;
}

export function pickAgent(team: Bot[], need: { tool?: ToolKey; skills?: string[]; text: string }, exclude: string[] = []): Bot | undefined {
  const ranked = team
    .filter((b) => !exclude.includes(b.id))
    .map((bot) => ({ bot, score: scoreAgent(bot, need) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.bot;
}

const canDo = (team: Bot[], tool: ToolKey) => team.some((b) => b.tools[tool]);

// ── rule-based planner ──────────────────────────────────────────────────

interface Intent {
  id: string;
  test: RegExp;
  phase: "gather" | "produce" | "act";
  tool?: ToolKey;
  skill?: string;
  title: string;
  focus: string;
  capability: string;
  /** What to ask the agent factory for when nobody has the tool. */
  hire: string;
}

const INTENTS: Intent[] = [
  {
    id: "data",
    test: /spreadsheet|\.csv|\.xlsx|sales data|pipeline|funnel|dataset|data file|conversion rate/i,
    phase: "gather",
    tool: "dataAnalysis",
    skill: "data-analysis",
    title: "Analyse the data",
    focus: "Load the spreadsheet with analyze_spreadsheet, compute the totals, the funnel, the breakdowns and the trend, draw the charts, and report the numbers with the calculation behind each.",
    capability: "data analysis",
    hire: "a data analyst who analyses spreadsheets, calculates metrics and draws charts",
  },
  {
    id: "repo",
    test: /github\.com|\brepo(sitory)?\b|pull request|codebase|code review/i,
    phase: "gather",
    tool: "github",
    skill: "code-review",
    title: "Inspect the repository",
    focus: "Inspect the repository with github_inspect_repo, read the files you need, and report findings with the file each one is in. Do not change anything.",
    capability: "repository inspection",
    hire: "an engineer who inspects GitHub repositories and reviews code",
  },
  {
    id: "competitor",
    test: /competitor|competition|rival|versus|\bvs\b|benchmark against/i,
    phase: "gather",
    tool: "webSearch",
    skill: "competitor-analysis",
    title: "Research the competitors",
    focus: "Find the main competitors, open their own pages, and compare offer, price, audience and positioning. Give a source link for every claim.",
    capability: "web research",
    hire: "a research analyst who studies competitors on the web",
  },
  {
    id: "research",
    test: /research|market|trend|intelligence|landscape|find out|look into|study|what are students/i,
    phase: "gather",
    tool: "webSearch",
    skill: "market-research",
    title: "Research the market",
    focus: "Search, open the best sources, and report what they say about the market, the audience and current trends. Give a source link for every claim and say what you could not verify.",
    capability: "web research",
    hire: "a market researcher who finds and reads sources on the web",
  },
  {
    id: "finance",
    test: /pricing|revenue model|financial|budget|unit economics|forecast|roi\b/i,
    phase: "produce",
    skill: "financial-modelling",
    title: "Build the financial view",
    focus: "Build the numbers step by step from stated assumptions. Show a base, low and high case.",
    capability: "financial modelling",
    hire: "a finance analyst who builds simple financial models",
  },
  {
    id: "leads",
    test: /lead gen|leads?\b.*(list|find|qualif)|prospect/i,
    phase: "produce",
    skill: "lead-generation",
    title: "Define and qualify leads",
    focus: "Define the ideal lead, where to find them, and how to qualify them.",
    capability: "lead generation",
    hire: "a growth specialist who finds and qualifies leads",
  },
  {
    id: "campaign",
    test: /campaign|content calendar|\b\d+[- ]day\b|social media|launch plan|marketing plan|go-to-market/i,
    phase: "produce",
    skill: "campaign-strategy",
    title: "Write the campaign",
    focus: "Write the campaign strategy and, if a calendar was asked for, the full day-by-day content calendar as a table. Use the research and data from earlier tasks.",
    capability: "campaign and content writing",
    hire: "a marketing strategist who writes campaigns and content calendars",
  },
  {
    id: "deck",
    test: /presentation|slides|deck\b/i,
    phase: "produce",
    skill: "presentation-creation",
    title: "Outline the presentation",
    focus: "Write the slide-by-slide outline with the message and the evidence for each slide.",
    capability: "presentation writing",
    hire: "a presentation writer who turns findings into slide outlines",
  },
  {
    id: "issue",
    test: /(open|create|file|raise)\s+(an?\s+)?(github\s+)?issue/i,
    phase: "act",
    tool: "github",
    title: "Open the GitHub issue",
    focus: "Open one issue with github_create_issue that states the most important finding, the evidence and the suggested fix. It needs the person's approval; if they reject it, do not retry and report that nothing was opened.",
    capability: "GitHub write",
    hire: "an engineer who can open GitHub issues",
  },
  {
    id: "email",
    test: /\b(send|email)\b.*\b[\w.+-]+@[\w-]+\.[\w.]+|send (an? |the )?email|email (it|this|the)/i,
    phase: "act",
    tool: "email",
    skill: "email-drafting",
    title: "Send the email",
    focus: "Write the email from the earlier results and send it with send_email. It needs the person's approval; if they reject it, do not retry and report that it was not sent.",
    capability: "email",
    hire: "an outreach agent who drafts and sends email",
  },
  {
    id: "slack",
    test: /\bslack\b/i,
    phase: "act",
    tool: "slack",
    title: "Post to Slack",
    focus: "Post a short summary of the result with slack_post. It needs the person's approval.",
    capability: "Slack",
    hire: "an agent who posts updates to Slack",
  },
  {
    id: "notion",
    test: /\bnotion\b/i,
    phase: "act",
    tool: "notion",
    title: "Create the Notion page",
    focus: "Create a Notion page with the result using notion_create_page. It needs the person's approval.",
    capability: "Notion",
    hire: "an agent who writes pages in Notion",
  },
];

const goalOf = (instruction: string) => instruction.trim().replace(/\s+/g, " ").slice(0, 140);

/** Plan by matching the request to capabilities. General, not tied to any one request. */
export function planByRules(instruction: string, team: Bot[], startRef = 1, includeReview = true): PlanDraft {
  const matched = INTENTS.filter((i) => i.test.test(instruction));
  // "competitor" already covers research; keep both only when both were clearly asked for.
  const intents = matched.filter((i) => !(i.id === "research" && matched.some((m) => m.id === "competitor") && !/market|trend/i.test(instruction)));
  const notes: string[] = [];
  const newAgents: string[] = [];
  const tasks: PlannedTask[] = [];
  let n = startRef;

  if (!intents.length) {
    if (instruction.trim().split(/\s+/).length <= 12) return { direct: true, goal: goalOf(instruction), tasks: [], plannedBy: "rules", newAgents, notes };
    const skills = selectSkills(instruction, [], 1).map((s) => s.id);
    const agent = pickAgent(team, { skills, text: instruction });
    if (agent) tasks.push({ ref: `T${n++}`, title: "Do the work", description: instruction, agentId: agent.id, dependsOn: [], skills, capability: "general", kind: "work", needsApproval: false });
    return { direct: tasks.length === 0, goal: goalOf(instruction), tasks, plannedBy: "rules", newAgents, notes };
  }

  const byPhase = (phase: Intent["phase"]) => intents.filter((i) => i.phase === phase);
  const add = (intent: Intent, dependsOn: string[]) => {
    if (intent.tool && !canDo(team, intent.tool)) {
      newAgents.push(intent.hire);
      notes.push(`Nobody on the team can do "${intent.capability}", so an agent will be created for it.`);
    }
    const skills = intent.skill ? [intent.skill] : [];
    if (intent.id === "campaign" && /calendar|\d+[- ]day/i.test(instruction)) skills.push("content-calendar");
    const agent = pickAgent(team, { tool: intent.tool, skills, text: `${intent.capability} ${intent.title}` });
    const ref = `T${n++}`;
    tasks.push({
      ref,
      title: intent.title,
      description: `The person asked: "${instruction.trim()}"\n\nYour part: ${intent.focus}`,
      agentId: agent?.id ?? "",
      dependsOn,
      skills,
      capability: intent.capability,
      kind: "work",
      needsApproval: intent.phase === "act",
    });
    return ref;
  };

  const gathered = byPhase("gather").map((i) => add(i, []));
  const produced = byPhase("produce").map((i) => add(i, gathered));
  const before = produced.length ? produced : gathered;

  // A second pair of eyes before anything is sent or reported, when the team has a reviewer.
  let reviewRef: string | null = null;
  const authors = new Set(tasks.map((t) => t.agentId));
  const reviewers = team.filter((b) => b.role !== "chief" && !authors.has(b.id));
  const reviewer = reviewers.find((b) => /review|qa\b|verif|quality/i.test(b.title)) ?? reviewers.find((b) => /verif|fact.?check|checks work/i.test(b.description));
  if (includeReview && reviewer && before.length) {
    reviewRef = `T${n++}`;
    tasks.push({
      ref: reviewRef,
      title: "Verify the work",
      description: "Check the earlier results against their sources and against the person's request. Start with VERIFIED or NEEDS CHANGES on the first line, then list each problem with the evidence.",
      agentId: reviewer.id,
      dependsOn: before,
      skills: [],
      capability: "review",
      kind: "review",
      needsApproval: false,
    });
  }
  for (const intent of byPhase("act")) add(intent, reviewRef ? [...before, reviewRef] : before);

  return { direct: false, goal: goalOf(instruction), tasks, plannedBy: "rules", newAgents, notes };
}

// ── model planner ───────────────────────────────────────────────────────

const TaskSchema = z.object({
  ref: z.string().optional(),
  title: z.string().min(2).max(120),
  description: z.string().min(5).max(3000),
  agent: z.string().optional().default(""),
  dependsOn: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
  capability: z.string().optional().default(""),
  kind: z.enum(["work", "review"]).optional().default("work"),
  needsApproval: z.boolean().optional().default(false),
});

const PlanSchema = z.object({
  direct: z.boolean().optional().default(false),
  goal: z.string().optional().default(""),
  tasks: z.array(TaskSchema).optional().default([]),
  newAgents: z.array(z.string()).optional().default([]),
});

const AmendSchema = z.object({
  cancel: z.array(z.string()).optional().default([]),
  add: z.array(TaskSchema).optional().default([]),
  note: z.string().optional().default(""),
});

function toolList(bot: Bot): string {
  const names: Record<string, string> = { webSearch: "web research", dataAnalysis: "spreadsheet analysis + charts", github: "GitHub", email: "email", slack: "Slack", notion: "Notion", codeMode: "code", browser: "browser" };
  return Object.entries(names).filter(([k]) => bot.tools[k as ToolKey]).map(([, v]) => v).join(", ") || "writing and reasoning only";
}

function roster(team: Bot[]): string {
  return team.map((b) => `- @${b.handle} (${b.name}, ${b.title || "agent"}): ${b.description || "no description"} Tools: ${toolList(b)}. Skills: ${b.skills.join(", ") || "none pinned"}.`).join("\n");
}

const PLAN_RULES = [
  "Rules:",
  "- Split the work into 2-7 tasks. Each task is one deliverable for one agent, with a brief that stands on its own.",
  "- Give tasks that do not need each other no dependencies, so they run in parallel.",
  "- Assign each task to the agent whose tools and role fit best. Only an agent with the tool can use it.",
  "- Add a review task (kind \"review\") before anything is sent outside the app or when facts need checking.",
  "- Mark needsApproval true for tasks that send email, post to Slack/Notion or change a GitHub repository.",
  "- Do NOT add a final summary task; the app adds consolidation itself.",
  "- If nobody on the team has a capability the work needs, describe the agent to create in newAgents.",
  "- If the message is a greeting or a simple question that needs no plan, return {\"direct\": true}.",
].join("\n");

const TASK_SHAPE = '{"ref":"T1","title":"...","description":"full brief","agent":"handle","dependsOn":["T1"],"skills":["skill-id"],"capability":"what it needs","kind":"work"|"review","needsApproval":false}';

function resolveTasks(raw: z.infer<typeof TaskSchema>[], team: Bot[], startRef: number, knownRefs: string[] = []): PlannedTask[] {
  const skillIds = new Set(listSkills().map((s) => s.id));
  const refs = raw.map((t, i) => t.ref?.trim() || `T${startRef + i}`);
  const tasks = raw.map((t, i): PlannedTask => {
    const handle = t.agent.replace(/^@/, "").toLowerCase();
    const named = team.find((b) => b.handle === handle || b.name.toLowerCase() === handle);
    const text = `${t.capability} ${t.title} ${t.description}`;
    const skills = t.skills.filter((s) => skillIds.has(s));
    const agent = named ?? pickAgent(team, { skills, text });
    return {
      ref: refs[i],
      title: t.title,
      description: t.description,
      agentId: agent?.id ?? "",
      dependsOn: t.dependsOn.filter((d) => d !== refs[i] && (refs.includes(d) || knownRefs.includes(d))),
      skills: skills.length ? skills : selectSkills(text, [], 1).map((s) => s.id),
      capability: t.capability || "general",
      kind: t.kind,
      needsApproval: t.needsApproval,
    };
  });
  // Break dependency cycles: a task may only depend on tasks that can finish before it.
  const done = new Set<string>(knownRefs);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of tasks) {
      if (!done.has(t.ref) && t.dependsOn.every((d) => done.has(d))) {
        done.add(t.ref);
        progressed = true;
      }
    }
  }
  for (const t of tasks) if (!done.has(t.ref)) t.dependsOn = t.dependsOn.filter((d) => done.has(d));
  return tasks;
}

export async function makePlan(instruction: string, chief: Bot, team: Bot[], room: Room | null): Promise<PlanDraft> {
  const rules = planByRules(instruction, team);
  const answer = await complete({
    purpose: "planning",
    tier: "strong",
    botId: chief.id,
    model: chief.modelMode === "fixed" ? chief.model : null,
    fallbacks: chief.fallbackModels,
    system: `You are ${chief.name}, the Chief of Staff of a team of AI agents. You turn one instruction into a task plan. Return ONLY a JSON object, no prose.`,
    prompt: [
      `Instruction from the person:\n"""${instruction}"""`,
      `Team:\n${roster(team)}`,
      `Skills library:\n${listSkills().map((s) => `- ${s.id}: ${s.description}`).join("\n")}`,
      `Data files available: ${listDataFiles().map((f) => f.name).join(", ") || "none"}`,
      sharedMemoryForPrompt(room?.id, room?.name) ? `Shared memory (follow the person's preferences and settled decisions):\n${sharedMemoryForPrompt(room?.id, room?.name)}` : "",
      PLAN_RULES,
      `JSON shape: {"direct": false, "goal": "one line", "tasks": [${TASK_SHAPE}], "newAgents": ["description of an agent to create"]}`,
    ].filter(Boolean).join("\n\n"),
  });
  const parsed = answer ? PlanSchema.safeParse(parseJson(answer.text)) : null;
  if (!answer || !parsed?.success) {
    if (answer) rules.notes.push("The model's plan could not be read, so the built-in planner was used.");
    return rules;
  }
  const data = parsed.data;
  if (data.direct || data.tasks.length === 0) return { direct: true, goal: goalOf(instruction), tasks: [], plannedBy: "model", model: answer.model, newAgents: [], notes: [] };
  const notes = answer.failed.map((f) => `Planning fell back from ${f.model}: ${f.error.slice(0, 120)}`);
  return {
    direct: false,
    goal: data.goal.trim() || goalOf(instruction),
    tasks: resolveTasks(data.tasks.slice(0, 10), team, 1),
    plannedBy: "model",
    model: answer.model,
    newAgents: data.newAgents.slice(0, 2),
    notes,
  };
}

export interface Amendment {
  /** Refs of unfinished tasks to cancel. */
  cancel: string[];
  add: PlannedTask[];
  note: string;
  plannedBy: "model" | "rules";
}

/** A new instruction arrived while a plan is running: decide what changes. */
export async function planAmendment(plan: Plan, text: string, chief: Bot, team: Bot[]): Promise<Amendment> {
  const nextRef = plan.tasks.length + 1;
  const open = plan.tasks.filter((t) => ["pending", "running", "awaiting-approval"].includes(t.status) && t.kind !== "consolidate");
  const answer = await complete({
    purpose: "replanning",
    tier: "strong",
    botId: chief.id,
    planId: plan.id,
    model: chief.modelMode === "fixed" ? chief.model : null,
    fallbacks: chief.fallbackModels,
    system: `You are ${chief.name}, the Chief of Staff. A plan is running and the person just sent a new instruction. Decide how the plan changes. Return ONLY a JSON object.`,
    prompt: [
      `Original instruction:\n"""${plan.instruction}"""`,
      `Current plan:\n${plan.tasks.map((t) => `- ${t.ref} [${t.status}] ${t.title} (agent: ${team.find((b) => b.id === t.agentId)?.handle ?? "?"})`).join("\n")}`,
      `New instruction:\n"""${text}"""`,
      `Team:\n${roster(team)}`,
      "Rules:\n- Cancel only unfinished tasks the new instruction makes unnecessary.\n- Add tasks only for new work. New tasks may depend on existing refs.\n- Unfinished tasks will see the new instruction automatically; do not re-add them.\n- Start new refs at T" + nextRef + ".",
      `JSON shape: {"cancel": ["T3"], "add": [${TASK_SHAPE}], "note": "one line telling the person what changed"}`,
    ].join("\n\n"),
  });
  const parsed = answer ? AmendSchema.safeParse(parseJson(answer.text)) : null;
  if (answer && parsed?.success) {
    const openRefs = new Set(open.map((t) => t.ref));
    return {
      cancel: parsed.data.cancel.filter((r) => openRefs.has(r)),
      add: resolveTasks(parsed.data.add.slice(0, 5), team, nextRef, plan.tasks.map((t) => t.ref)),
      note: parsed.data.note || "Plan updated with your new instruction.",
      plannedBy: "model",
    };
  }
  // Rules: add tasks for any new kind of work the instruction names; everything unfinished sees the new instruction.
  const extra = planByRules(text, team, nextRef, false);
  const have = new Set(plan.tasks.filter((t) => !["cancelled", "failed", "skipped"].includes(t.status)).map((t) => t.title));
  const add = extra.tasks.filter((t) => !have.has(t.title));
  // "instead of X" / "drop X" / "skip X": cancel unfinished tasks whose title shares a word with X.
  const dropped = text.match(/\b(?:instead of|drop|skip|don'?t do|no need for|forget)\s+(?:the\s+)?([^.,;]+)/i)?.[1] ?? "";
  const dropWords = words(dropped);
  const cancel = dropWords.size ? open.filter((t) => [...words(t.title + " " + t.capability)].some((w) => dropWords.has(w))).map((t) => t.ref) : [];
  const parts = [add.length ? `added ${add.map((t) => `${t.ref} ${t.title}`).join(", ")}` : "", cancel.length ? `cancelled ${cancel.join(", ")}` : "", "unfinished tasks now follow the new instruction"].filter(Boolean);
  return { cancel, add, note: `Plan updated: ${parts.join("; ")}.`, plannedBy: "rules" };
}

/** Best skill ids for a task, for agents picked without a planner hint. */
export function skillsFor(text: string, bot: Bot): string[] {
  const all = listSkills();
  const pinned = bot.skills.filter((id) => {
    const s = all.find((x) => x.id === id);
    return s && scoreSkill(s, text) >= 1.5;
  });
  return [...new Set([...selectSkills(text, [], 2).map((s) => s.id), ...pinned])].slice(0, 3);
}

/** The tool switch a piece of work needs, read from its wording. */
export function toolFor(text: string): keyof BotTools | undefined {
  if (/spreadsheet|data analysis|\.csv|funnel/i.test(text)) return "dataAnalysis";
  if (/github|repositor/i.test(text)) return "github";
  if (/\bemail\b/i.test(text)) return "email";
  if (/\bslack\b/i.test(text)) return "slack";
  if (/\bnotion\b/i.test(text)) return "notion";
  if (/web research|search the web|competitor|market research/i.test(text)) return "webSearch";
  return undefined;
}
