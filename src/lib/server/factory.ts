// The agent factory: turn a plain-language description into a configured agent.
// A model drafts the agent when one is available; otherwise keyword rules do.
// Either way the result is an ordinary bot row, so no source file changes.
import { z } from "zod";
import type { AgentDraft, ApprovalMode, Bot, BotInput, BotTools } from "@/lib/shared/types";
import { complete, parseJson } from "./llm";
import { appendScope } from "./memory-files";
import { defaultModelId } from "./providers";
import { listSkills, selectSkills } from "./skills";

interface RoleRule {
  test: RegExp;
  title: string;
  emoji: string;
  color: string;
  tools: Partial<BotTools>;
  skills: string[];
  instructions: string;
  outputFormat: string;
}

const ROLE_RULES: RoleRule[] = [
  {
    test: /research|market|competitor|intelligence|analyst|trend|scout/i,
    title: "Research",
    emoji: "🔎",
    color: "#2f7df6",
    tools: { webSearch: true },
    skills: ["market-research", "competitor-analysis"],
    instructions: "Search first, open the best sources, and answer with the URLs you used. Separate what a source says from what you infer. Say plainly when you could not verify something.",
    outputFormat: "Short summary first, then findings as bullets with a source link on each.",
  },
  {
    test: /data|spreadsheet|sales|analytics|numbers|csv|pipeline|metric/i,
    title: "Data analysis",
    emoji: "📊",
    color: "#7a5af5",
    tools: { dataAnalysis: true, codeMode: true },
    skills: ["data-analysis"],
    instructions: "Compute every number with analyze_spreadsheet or code. Show the calculation behind each headline figure and name data-quality problems you found.",
    outputFormat: "Headline numbers, a table per breakdown, the charts, then three recommendations tied to the numbers.",
  },
  {
    test: /financ|pricing|revenue|budget|unit economics|forecast/i,
    title: "Finance",
    emoji: "💹",
    color: "#0e9f6e",
    tools: { dataAnalysis: true, codeMode: true },
    skills: ["financial-modelling"],
    instructions: "State every assumption with its source. Build the model step by step and show a base, low and high case.",
    outputFormat: "Assumptions table, the model, sensitivity, then the conclusion.",
  },
  {
    test: /code|engineer|developer|github|repo|pull request|technical|devops/i,
    title: "Engineering",
    emoji: "🛠️",
    color: "#475569",
    tools: { github: true, webSearch: true },
    skills: ["code-review", "repo-monitoring"],
    instructions: "Inspect the repository before commenting. Cite the file for every finding. Propose changes as issues; never change a repository without approval.",
    outputFormat: "Findings ordered by severity, each with file, evidence and a suggested fix.",
  },
  {
    test: /email|outreach|sales rep|lead|prospect|crm/i,
    title: "Outreach",
    emoji: "📨",
    color: "#d9488b",
    tools: { email: true, webSearch: true },
    skills: ["email-drafting", "lead-generation"],
    instructions: "Write short, specific emails. Show the draft before sending. Sending always goes through approval.",
    outputFormat: "Subject line, then the email body, then one line on why it should work.",
  },
  {
    test: /content|copy|writer|social|marketing|campaign|brand|creative/i,
    title: "Marketing",
    emoji: "📣",
    color: "#e0663d",
    tools: { webSearch: true },
    skills: ["campaign-strategy", "content-calendar"],
    instructions: "Start from the audience and one clear message. Make every item specific enough to publish: channel, format, hook and call to action.",
    outputFormat: "Strategy in five lines, then the plan as a table.",
  },
  {
    test: /review|qa|verif|fact.?check|critic|legal|compliance|risk|audit/i,
    title: "Review",
    emoji: "🧪",
    color: "#b45309",
    tools: { webSearch: true },
    skills: [],
    instructions: "Check work before it ships. Test each claim against its source. Answer VERIFIED or NEEDS CHANGES on the first line, then list each problem with the evidence.",
    outputFormat: "First line VERIFIED or NEEDS CHANGES, then numbered issues.",
  },
  {
    test: /present|slides|deck|report|summary|brief/i,
    title: "Reporting",
    emoji: "🗂️",
    color: "#0891b2",
    tools: {},
    skills: ["presentation-creation", "daily-summary"],
    instructions: "Turn material into a clear, ordered document. One message per section, evidence under it.",
    outputFormat: "Title, summary, then sections with headings.",
  },
];

const GENERAL: RoleRule = {
  test: /.*/,
  title: "Specialist",
  emoji: "✨",
  color: "#64748b",
  tools: { webSearch: true },
  skills: [],
  instructions: "Do the work you are given carefully and say what you could not do.",
  outputFormat: "",
};

const BASE_TOOLS: BotTools = {
  webSearch: false,
  memory: true,
  codeMode: false,
  browser: false,
  askUser: true,
  collaboration: true,
  dataAnalysis: false,
  github: false,
  email: false,
  slack: false,
  notion: false,
  artifacts: true,
};

const titleCase = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "a legal reviewer who checks contracts" → "Legal Reviewer" */
function roleName(description: string): string {
  const named = description.match(/\b(?:called|named)\s+["']?([A-Za-z][\w-]{1,20})/);
  if (named) return titleCase(named[1]);
  const role = description
    .replace(/^\s*(?:please\s+)?(?:create|make|add|build|i need|we need|hire)\s+/i, "")
    .replace(/^\s*(?:an?|the|new)\s+/i, "")
    .replace(/^(?:agent|bot)\s+(?:that|who|to|for)\s+/i, "")
    .split(/\b(?:who|that|which|to|for|with)\b|[,.;:]/i)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
  return titleCase(role || "Specialist").slice(0, 30);
}

function approvalFrom(text: string): ApprovalMode {
  if (/full access|without asking|autonomous/i.test(text)) return "full";
  if (/controlled|pre-?approved|within limits/i.test(text)) return "controlled";
  return "ask";
}

function draftByRules(description: string, model: string): AgentDraft {
  const matched = ROLE_RULES.filter((r) => r.test.test(description));
  const rules = matched.length ? matched : [GENERAL];
  const first = rules[0];
  const tools: BotTools = { ...BASE_TOOLS };
  for (const r of rules) Object.assign(tools, r.tools);
  if (/slack/i.test(description)) tools.slack = true;
  if (/notion/i.test(description)) tools.notion = true;
  if (/\bemail/i.test(description)) tools.email = true;
  if (/github|repo/i.test(description)) tools.github = true;
  if (/browser|website forms|log ?in/i.test(description)) tools.browser = true;
  const skills = [...new Set([...rules.flatMap((r) => r.skills), ...selectSkills(description, [], 3).map((s) => s.id)])].slice(0, 4);
  const format = description.match(/(?:output|format|respond|reply|answers?)\s+(?:as|in|with)\s+([^.;]+)/i);
  const name = roleName(description);
  return {
    input: {
      name,
      title: first.title,
      description: description.trim().replace(/\s+/g, " ").slice(0, 200),
      instructions: [`Your job: ${description.trim()}`, ...rules.map((r) => r.instructions)].join("\n\n"),
      emoji: first.emoji,
      color: first.color,
      model,
      modelMode: "auto",
      tools,
      skills,
      approval: approvalFrom(description),
      outputFormat: format ? format[1].trim() : first.outputFormat,
      pinned: false,
      role: "member",
    },
    rationale: `Matched the description to: ${rules.map((r) => r.title).join(", ")}. Tools and skills follow from that. Permission level is "${approvalFrom(description)}" because ${approvalFrom(description) === "ask" ? "nothing in the description asked for more" : "the description asked for it"}.`,
    memorySeed: `- Created from this description: "${description.trim().slice(0, 300)}"`,
    draftedBy: "rules",
  };
}

const TOOL_KEYS = ["webSearch", "memory", "codeMode", "browser", "askUser", "collaboration", "dataAnalysis", "github", "email", "slack", "notion", "artifacts"] as const;

const DraftSchema = z.object({
  name: z.string().min(2).max(40),
  title: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
  instructions: z.string().min(20).max(4000),
  emoji: z.string().max(8).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  skills: z.array(z.string()).optional(),
  approval: z.enum(["ask", "controlled", "full"]).optional(),
  outputFormat: z.string().max(400).optional(),
  memory: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

/** Propose an agent without creating it, so the person can review and edit first. */
export async function draftAgent(description: string): Promise<AgentDraft> {
  const model = await defaultModelId();
  const base = draftByRules(description, model);
  const answer = await complete({
    purpose: "agent-factory",
    tier: "balanced",
    system:
      "You design AI agents for a multi-agent workspace. Return ONLY a JSON object, no prose. Be conservative with permissions: use \"ask\" unless the description clearly requests more.",
    prompt: [
      `Design an agent from this description:\n"""${description}"""`,
      `Available tool switches (booleans): ${TOOL_KEYS.join(", ")}.`,
      `Available skills:\n${listSkills().map((s) => `- ${s.id}: ${s.description}`).join("\n")}`,
      'JSON shape: {"name": short name, "title": role in 1-3 words, "description": one sentence, "instructions": the persona and working rules in 4-8 sentences, "emoji": one emoji, "tools": {switch: true|false}, "skills": [skill ids], "approval": "ask"|"controlled"|"full", "outputFormat": how answers should be shaped, "memory": [1-3 starting notes], "rationale": one sentence on your choices}',
    ].join("\n\n"),
  });
  const parsed = answer ? DraftSchema.safeParse(parseJson(answer.text)) : null;
  if (!parsed?.success) return base;
  const d = parsed.data;
  const known = new Set(listSkills().map((s) => s.id));
  const tools = { ...base.input.tools };
  for (const key of TOOL_KEYS) if (typeof d.tools?.[key] === "boolean") tools[key] = d.tools[key];
  tools.memory = true;
  return {
    input: {
      ...base.input,
      name: d.name.trim(),
      title: d.title?.trim() || base.input.title,
      description: d.description?.trim() || base.input.description,
      instructions: d.instructions.trim(),
      emoji: d.emoji?.trim() || base.input.emoji,
      tools,
      skills: (d.skills ?? base.input.skills ?? []).filter((s) => known.has(s)).slice(0, 4),
      approval: d.approval ?? base.input.approval,
      outputFormat: d.outputFormat?.trim() ?? base.input.outputFormat,
    },
    rationale: d.rationale?.trim() || base.rationale,
    memorySeed: [base.memorySeed, ...(d.memory ?? []).map((m) => `- ${m}`)].join("\n"),
    draftedBy: "model",
  };
}

/** Create the agent from a reviewed draft. */
export async function createAgentFromDraft(input: BotInput, memorySeed: string, createdBy: Bot["createdBy"] = "factory"): Promise<Bot> {
  const { createBot } = await import("./service");
  const bot = await createBot({ ...input, createdBy });
  for (const line of memorySeed.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)) {
    appendScope(`agent:${bot.id}`, line, { by: "System", why: "starting memory from the agent factory", source: "agent factory" });
  }
  return bot;
}

export async function createAgentFromDescription(description: string, createdBy: Bot["createdBy"] = "factory"): Promise<Bot> {
  const draft = await draftAgent(description);
  return createAgentFromDraft(draft.input, draft.memorySeed, createdBy);
}
