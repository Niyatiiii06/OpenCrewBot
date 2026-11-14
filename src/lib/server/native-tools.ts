// Tools added in OpenCrewBot 2.0, next to the original web, memory, code and
// browser tools. Each tool registers what it is and how risky it is in
// TOOL_META, so the Skills & Tools page, the approval previews and the
// permission checks all read from one place.
//
// External actions (email, Slack, Notion, GitHub issues) go through `gate()`
// before anything is sent. If the gate does not return allowed, the function
// that performs the action is never called.
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Bot, ToolInfo } from "@/lib/shared/types";
import { keys } from "./config";
import { getBot } from "./db";
import { artifactUrl, saveArtifact } from "./artifacts";
import { analyze, chartSvg, chartsFor, listDataFiles } from "./data-analysis";
import { createIssue, inspectRepo, notionCreatePage, readFile, readPage, searchWeb, sendEmail, slackPost, type ActionResult } from "./integrations";
import { appendScope, editScope } from "./memory-files";
import { TOOL_META, gate, recordExecution, type ToolMeta } from "./permissions";
import { getSkill, listSkills, skillBrief } from "./skills";
import { turnOf } from "./turns";

function define(name: string, meta: ToolMeta) {
  TOOL_META.set(name, meta);
}

const text = (v: unknown) => String(v ?? "");

// ── catalog ─────────────────────────────────────────────────────────────

define("web_search", { label: "Search the web", group: "Research", risk: "read", description: "Search the web and return titles, links and snippets." });
define("read_page", { label: "Read a web page", group: "Research", risk: "read", description: "Fetch a public page and return its text." });
define("crawl_site", { label: "Crawl a site", group: "Research", risk: "read", description: "Follow links on one site and read several pages (Tavily only)." });
define("memory_add", { label: "Save to memory", group: "Memory", risk: "local", description: "Add one line to the agent's own memory or to a shared memory file." });
define("memory_edit", { label: "Edit memory", group: "Memory", risk: "local", description: "Correct or remove a line in a memory file." });
define("use_skill", { label: "Load a skill", group: "Skills", risk: "read", description: "Load the full instructions of a skill from the library." });
define("analyze_spreadsheet", { label: "Analyse a spreadsheet", group: "Data", risk: "read", description: "Load a CSV file and compute totals, a funnel, segment cuts and a monthly trend." });
define("make_chart", { label: "Draw a chart", group: "Data", risk: "local", description: "Draw a bar or line chart and save it as an SVG file." });
define("list_data_files", { label: "List data files", group: "Data", risk: "read", description: "List the spreadsheets available to analyse." });
define("save_artifact", { label: "Save a deliverable", group: "Deliverables", risk: "local", description: "Save a report, draft or table as a file the person can open." });
define("github_inspect_repo", { label: "Inspect a GitHub repository", group: "GitHub", risk: "read", description: "Read a repository's structure, dependencies, commits, issues and run structural checks." });
define("github_read_file", { label: "Read a file on GitHub", group: "GitHub", risk: "read", description: "Read one file or list one folder of a repository." });
define("github_create_issue", {
  label: "Open a GitHub issue",
  group: "GitHub",
  risk: "external",
  description: "Open an issue in a repository. Changes something outside the app.",
  describe: (a) => ({ title: `Open a GitHub issue in ${text(a.repo)}: "${text(a.title)}"`, preview: `Repository: ${text(a.repo)}\nTitle: ${text(a.title)}\n\n${text(a.body)}` }),
});
define("send_email", {
  label: "Send an email",
  group: "Email",
  risk: "external",
  description: "Send an email from the connected Gmail account.",
  describe: (a) => ({ title: `Send an email to ${text(a.to)}: "${text(a.subject)}"`, preview: `To: ${text(a.to)}\nSubject: ${text(a.subject)}\n\n${text(a.body)}` }),
});
define("slack_post", {
  label: "Post to Slack",
  group: "Slack",
  risk: "external",
  description: "Post a message to the connected Slack channel.",
  describe: (a) => ({ title: "Post a message to Slack", preview: text(a.text) }),
});
define("notion_create_page", {
  label: "Create a Notion page",
  group: "Notion",
  risk: "external",
  description: "Create a page in the connected Notion workspace.",
  describe: (a) => ({ title: `Create a Notion page: "${text(a.title)}"`, preview: `Title: ${text(a.title)}\n\n${text(a.content)}` }),
});
define("delegate_task", { label: "Delegate to a teammate", group: "Collaboration", risk: "local", description: "Hand a piece of work to a teammate. It becomes a tracked task." });
define("ask_teammate", { label: "Ask a teammate", group: "Collaboration", risk: "local", description: "Ask a teammate a question and wait for the answer." });
define("request_verification", { label: "Request verification", group: "Collaboration", risk: "local", description: "Ask a teammate to check a claim or a piece of work before it is used." });
define("challenge_conclusion", { label: "Challenge a conclusion", group: "Collaboration", risk: "local", description: "Put an objection to a teammate, who must defend or revise the conclusion." });
define("share_finding", { label: "Share a finding", group: "Collaboration", risk: "local", description: "Post a finding to the room's shared memory so every teammate sees it." });
define("create_agent", { label: "Create an agent", group: "Workforce", risk: "local", description: "Create a new agent from a plain-language description (Chief of Staff)." });
define("schedule_workflow", { label: "Schedule a workflow", group: "Workforce", risk: "local", description: "Create a recurring workflow (Chief of Staff)." });
define("execute_typescript", { label: "Run code", group: "Code", risk: "read", description: "Run TypeScript in a sandbox with no file or network access (from the original app)." });
define("ask_user", { label: "Ask you", group: "Conversation", risk: "read", description: "Pause and ask you a question with a card in chat (from the original app)." });
define("browser_*", { label: "Cloud browser", group: "Browser", risk: "external", description: "Drive a Browserbase cloud browser (from the original app). Needs a Browserbase key." });
define("mcp_*", { label: "MCP server tools", group: "MCP", risk: "external", description: "Tools from MCP servers you added. Lookups run freely; changes ask first." });
define("COMPOSIO_*", { label: "Composio apps", group: "Composio", risk: "external", description: "Connected apps through Composio (from the original app). Needs a Composio key." });

/** Every tool with whether it can reach a real service right now. */
export async function toolCatalog(): Promise<ToolInfo[]> {
  const { listIntegrations } = await import("./integrations");
  const integrations = await listIntegrations();
  const stateOf = (id: string) => integrations.find((i) => i.id === id);
  const live = (name: string): { live: boolean; note?: string } => {
    if (name === "send_email") return { live: stateOf("gmail")?.state === "live", note: stateOf("gmail")?.detail };
    if (name === "slack_post") return { live: stateOf("slack")?.state === "live", note: stateOf("slack")?.detail };
    if (name === "notion_create_page") return { live: stateOf("notion")?.state === "live", note: stateOf("notion")?.detail };
    if (name === "github_create_issue") return { live: Boolean(stateOf("github")?.fields[0]?.set), note: "Needs a GitHub token; simulated without one." };
    if (name === "crawl_site") return { live: keys.tavily(), note: "Needs TAVILY_API_KEY." };
    if (name === "browser_*") return { live: keys.browserbase(), note: "Needs BROWSERBASE_API_KEY." };
    if (name === "COMPOSIO_*") return { live: keys.composio(), note: "Needs COMPOSIO_API_KEY." };
    if (name === "mcp_*") return { live: stateOf("mcp")?.state === "live", note: stateOf("mcp")?.detail };
    if (name === "web_search" || name === "read_page") return { live: true, note: keys.tavily() ? "Tavily" : "DuckDuckGo and direct fetch, no key" };
    return { live: true };
  };
  return [...TOOL_META.entries()].map(([name, m]) => ({ name, label: m.label, description: m.description, group: m.group, risk: m.risk, ...live(name) }));
}

// ── helpers ─────────────────────────────────────────────────────────────

type Ctx = unknown;

async function currentBot(botId: string): Promise<Bot> {
  const bot = await getBot(botId);
  if (!bot) throw new Error("This agent no longer exists.");
  return bot;
}

/** Run an external action only after the approval gate clears it. */
async function guarded(botId: string, tool: string, args: Record<string, unknown>, ctx: Ctx, run: () => Promise<ActionResult>) {
  const bot = await currentBot(botId);
  const turn = turnOf(ctx, botId);
  const cleared = await gate(bot, tool, args, turn);
  if (!cleared.allowed) {
    return {
      executed: false,
      [cleared.outcome]: true,
      message: `NOT EXECUTED: ${cleared.reason}. Nothing was sent or changed. Do not try again or work around this; tell the person it was not done.`,
    };
  }
  const result = await run();
  await recordExecution(bot, tool, result.detail, turn, result.simulated, cleared.approvalId);
  return {
    executed: !result.simulated,
    simulated: result.simulated,
    detail: result.detail,
    url: result.url,
    message: result.simulated ? `SIMULATED: ${result.detail}` : result.detail,
  };
}

const SCOPES = ["self", "room", "project", "user", "decision"] as const;

function scopeId(scope: (typeof SCOPES)[number], botId: string, conversationId: string): string {
  if (scope === "room") {
    if (!conversationId.startsWith("room:")) return `agent:${botId}`;
    return conversationId;
  }
  if (scope === "project") return "project";
  if (scope === "user") return "user";
  if (scope === "decision") return "decisions";
  return `agent:${botId}`;
}

// ── the tools one bot gets ──────────────────────────────────────────────

export interface NativeToolset {
  tools: ToolsInput;
  capabilities: string[];
}

export function buildNativeTools(bot: Bot): NativeToolset {
  const tools: ToolsInput = {};
  const capabilities: string[] = [];
  const botId = bot.id;

  if (bot.tools.memory) {
    tools.memory_add = createTool({
      id: "memory_add",
      description:
        "Save one durable fact. scope: 'self' for your own notes; 'user' for how the person likes things done; 'project' for facts about the business; 'decision' for a decision that was made; 'room' for a note your teammates in this room should see. One short line per call.",
      inputSchema: z.object({
        note: z.string().min(1).describe("The fact, as one short sentence."),
        scope: z.enum(SCOPES).nullable().describe("Where to save it. Defaults to 'self'."),
        why: z.string().nullable().describe("Why this is worth remembering, in a few words."),
        section: z.string().nullable().describe("Optional heading to file it under."),
      }),
      execute: async ({ note, scope, why, section }, ctx) => {
        const turn = turnOf(ctx, botId);
        const me = await currentBot(botId);
        const id = scopeId(scope ?? "self", botId, turn.conversationId);
        appendScope(id, note, { by: me.name, why: why ?? "stated in conversation", source: turn.taskId ? `task ${turn.taskId} in ${turn.conversationId}` : turn.conversationId }, section ?? undefined);
        return { saved: true, scope: id };
      },
    });
    tools.memory_edit = createTool({
      id: "memory_edit",
      description: "Fix or remove a line in a memory file. `find` must match the current text exactly once; use an empty `replace` to delete it.",
      inputSchema: z.object({ find: z.string().min(1), replace: z.string(), scope: z.enum(SCOPES).nullable() }),
      execute: async ({ find, replace, scope }, ctx) => {
        const turn = turnOf(ctx, botId);
        const me = await currentBot(botId);
        return editScope(scopeId(scope ?? "self", botId, turn.conversationId), find, replace, { by: me.name, why: "correction", source: turn.conversationId });
      },
    });
  }

  tools.use_skill = createTool({
    id: "use_skill",
    description: "Load the full instructions for one skill from the library, then follow them. Call it when a request matches a skill you have not loaded yet.",
    inputSchema: z.object({ skill: z.string().describe("The skill id from the skills list, e.g. 'competitor-analysis'.") }),
    execute: async ({ skill }) => {
      const found = getSkill(skill);
      if (!found) return { error: `No skill called "${skill}". Available: ${listSkills().map((s) => s.id).join(", ")}.` };
      return { skill: found.id, instructions: skillBrief(found) };
    },
  });

  if (bot.tools.webSearch && !keys.tavily()) {
    tools.web_search = createTool({
      id: "web_search",
      description: "Search the web. Returns titles, URLs and snippets. Open the best results with read_page before relying on them.",
      inputSchema: z.object({ query: z.string().min(2), maxResults: z.number().int().min(1).max(10).nullable() }),
      execute: async ({ query, maxResults }) => {
        const results = await searchWeb(query, maxResults ?? 6);
        return {
          query,
          results,
          markdown: results.length ? results.map((r, i) => `${i + 1}. [${r.title}](${r.url})${r.content ? `: ${r.content}` : ""}`).join("\n") : `No results for "${query}".`,
        };
      },
    });
    tools.read_page = createTool({
      id: "read_page",
      description: "Read one public web page and return its text. Use it to check what a search result actually says.",
      inputSchema: z.object({ url: z.string().min(4) }),
      execute: async ({ url }) => {
        const page = await readPage(url);
        return { url: page.url, title: page.title, content: page.text, results: [{ title: page.title, url: page.url }], markdown: `**${page.title}** (${page.url})\n\n${page.text.slice(0, 1800)}` };
      },
    });
    capabilities.push("Search the web (web_search) and read pages (read_page). Cite the URLs you used. A search snippet is a lead; open the page before stating a fact from it.");
  }

  if (bot.tools.dataAnalysis) {
    tools.list_data_files = createTool({
      id: "list_data_files",
      description: "List the spreadsheet files available to analyse.",
      inputSchema: z.object({}),
      execute: async () => ({ files: listDataFiles() }),
    });
    tools.analyze_spreadsheet = createTool({
      id: "analyze_spreadsheet",
      description:
        "Load a CSV file and compute its profile, the funnel by stage, performance by segment, and the monthly trend. Columns are detected automatically; name them only to override. Set charts=true to also draw the charts. Every number you report must come from this tool.",
      inputSchema: z.object({
        file: z.string().describe("File name, e.g. 'meetuniversity_sales_sample.csv'."),
        group_by: z.array(z.string()).nullable().describe("Columns to break results down by."),
        value_column: z.string().nullable(),
        stage_column: z.string().nullable(),
        stage_order: z.array(z.string()).nullable().describe("Funnel stages, earliest first."),
        date_column: z.string().nullable(),
        filter_column: z.string().nullable(),
        filter_equals: z.string().nullable(),
        charts: z.boolean().nullable(),
      }),
      execute: async (input, ctx) => {
        const turn = turnOf(ctx, botId);
        const analysis = analyze({
          file: input.file,
          groupBy: input.group_by ?? undefined,
          valueColumn: input.value_column ?? undefined,
          stageColumn: input.stage_column ?? undefined,
          stageOrder: input.stage_order ?? undefined,
          dateColumn: input.date_column ?? undefined,
          filter: input.filter_column && input.filter_equals ? { column: input.filter_column, equals: input.filter_equals } : undefined,
        });
        const charts: { title: string; markdown: string }[] = [];
        if (input.charts !== false) {
          for (const spec of chartsFor(analysis)) {
            const saved = await saveArtifact({ title: spec.title, content: chartSvg(spec), kind: "chart", ext: "svg", botId, planId: turn.planId, taskId: turn.taskId, conversationId: turn.conversationId });
            charts.push({ title: spec.title, markdown: `![${spec.title}](${artifactUrl(saved.file)})` });
          }
        }
        return {
          file: analysis.file,
          rows: analysis.rows,
          valueColumn: analysis.valueColumn,
          stageColumn: analysis.stageColumn,
          funnel: analysis.funnel?.stages ?? null,
          bottleneck: analysis.funnel?.bottleneck ?? null,
          won: analysis.won,
          groups: analysis.groups,
          trend: analysis.trend?.rows ?? null,
          quality: analysis.quality,
          charts,
          markdown: `${analysis.markdown}${charts.length ? `\n\n**Charts**\n\n${charts.map((c) => c.markdown).join("\n\n")}` : ""}`,
        };
      },
    });
    tools.make_chart = createTool({
      id: "make_chart",
      description: "Draw one bar or line chart from labels and numbers you already computed. Returns Markdown to paste into your report.",
      inputSchema: z.object({
        title: z.string(),
        type: z.enum(["bar", "line"]),
        labels: z.array(z.string()).min(1).max(24),
        values: z.array(z.number()).min(1).max(24),
        unit: z.string().nullable(),
      }),
      execute: async (input, ctx) => {
        const turn = turnOf(ctx, botId);
        const spec = { ...input, unit: input.unit ?? undefined };
        const saved = await saveArtifact({ title: spec.title, content: chartSvg(spec), kind: "chart", ext: "svg", botId, planId: turn.planId, taskId: turn.taskId, conversationId: turn.conversationId });
        return { saved: true, markdown: `![${spec.title}](${artifactUrl(saved.file)})` };
      },
    });
    capabilities.push(`Analyse spreadsheets with analyze_spreadsheet (files available: ${listDataFiles().map((f) => f.name).join(", ") || "none yet"}) and draw charts with make_chart. Never state a number you did not get from a tool.`);
  }

  if (bot.tools.artifacts) {
    tools.save_artifact = createTool({
      id: "save_artifact",
      description: "Save a finished deliverable (report, draft, calendar, table) as a Markdown file the person can open later. Returns its link.",
      inputSchema: z.object({ title: z.string().min(2), content: z.string().min(20), kind: z.enum(["report", "draft", "data"]).nullable() }),
      execute: async ({ title, content, kind }, ctx) => {
        const turn = turnOf(ctx, botId);
        const saved = await saveArtifact({ title, content, kind: kind ?? "report", botId, planId: turn.planId, taskId: turn.taskId, conversationId: turn.conversationId });
        return { saved: true, artifactId: saved.id, link: artifactUrl(saved.file) };
      },
    });
  }

  if (bot.tools.github) {
    tools.github_inspect_repo = createTool({
      id: "github_inspect_repo",
      description: "Inspect a GitHub repository: structure, languages, dependencies, recent commits, open issues and pull requests, plus structural checks (tests, CI, licence, committed secrets files, lockfile). Start every repository review with this.",
      inputSchema: z.object({ repo: z.string().describe("owner/name or a github.com URL") }),
      execute: async ({ repo }) => {
        const r = await inspectRepo(repo);
        return { repo: r.repo, url: r.url, findings: r.findings, issues: r.issues, pullRequests: r.pullRequests, recentCommits: r.recentCommits, topLevel: r.topLevel, dependencies: r.dependencies, readmeExcerpt: r.readmeExcerpt, markdown: r.markdown, results: [{ title: r.repo, url: r.url }] };
      },
    });
    tools.github_read_file = createTool({
      id: "github_read_file",
      description: "Read one file from a GitHub repository, or list a folder. Use it to check the code before reporting a finding about it.",
      inputSchema: z.object({ repo: z.string(), path: z.string().describe("File or folder path, e.g. 'src/index.ts'") }),
      execute: async ({ repo, path }) => {
        const f = await readFile(repo, path);
        return { repo: f.repo, path: f.path, url: f.url, content: f.content, markdown: `**${f.path}** (${f.url})\n\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\`` };
      },
    });
    tools.github_create_issue = createTool({
      id: "github_create_issue",
      description: "Open an issue in a GitHub repository. This changes something outside the app, so it asks the person first unless it was pre-approved.",
      inputSchema: z.object({ repo: z.string(), title: z.string().min(4), body: z.string().min(10), labels: z.array(z.string()).nullable() }),
      execute: async (args, ctx) => guarded(botId, "github_create_issue", args, ctx, () => createIssue(args.repo, args.title, args.body, args.labels ?? undefined)),
    });
    capabilities.push("Inspect GitHub repositories (github_inspect_repo), read their files (github_read_file) and propose issues (github_create_issue, which needs approval). Base findings on what you actually read.");
  }

  if (bot.tools.email) {
    tools.send_email = createTool({
      id: "send_email",
      description: "Send an email. This is an external action: the person sees the full email and approves or rejects it unless it was pre-approved. Draft the email in your reply first when you were only asked to write it.",
      inputSchema: z.object({ to: z.string().describe("One or more addresses, comma-separated"), subject: z.string().min(1), body: z.string().min(1) }),
      execute: async (args, ctx) => guarded(botId, "send_email", args, ctx, () => sendEmail(args.to, args.subject, args.body)),
    });
    capabilities.push("Send email with send_email. It waits for the person's approval; if they reject it, the email is not sent and you must not retry.");
  }
  if (bot.tools.slack) {
    tools.slack_post = createTool({
      id: "slack_post",
      description: "Post a message to the connected Slack channel. External action: asks first unless pre-approved.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async (args, ctx) => guarded(botId, "slack_post", args, ctx, () => slackPost(args.text)),
    });
    capabilities.push("Post to Slack with slack_post (asks the person first).");
  }
  if (bot.tools.notion) {
    tools.notion_create_page = createTool({
      id: "notion_create_page",
      description: "Create a page in the connected Notion workspace. External action: asks first unless pre-approved.",
      inputSchema: z.object({ title: z.string().min(1), content: z.string().min(1).describe("Markdown content of the page") }),
      execute: async (args, ctx) => guarded(botId, "notion_create_page", args, ctx, () => notionCreatePage(args.title, args.content)),
    });
    capabilities.push("Create Notion pages with notion_create_page (asks the person first).");
  }

  if (bot.tools.collaboration) {
    const collab = () => import("./collab");
    tools.ask_teammate = createTool({
      id: "ask_teammate",
      description: "Ask one teammate a question and get their answer back. Use it when a teammate knows or can find something you need. Do not use it for small talk.",
      inputSchema: z.object({ to: z.string().describe("The teammate's @handle or name"), question: z.string().min(5) }),
      execute: async ({ to, question }, ctx) => (await collab()).askTeammate(turnOf(ctx, botId), botId, to, question, "ask"),
    });
    tools.request_verification = createTool({
      id: "request_verification",
      description: "Ask a teammate to check a claim, number or draft before it is used. They answer VERIFIED or NEEDS CHANGES with reasons.",
      inputSchema: z.object({ to: z.string().nullable().describe("Who should check it. Leave empty for the room's reviewer."), content: z.string().min(10).describe("The claim or work to verify, with its sources") }),
      execute: async ({ to, content }, ctx) => (await collab()).askTeammate(turnOf(ctx, botId), botId, to ?? "", content, "verify"),
    });
    tools.challenge_conclusion = createTool({
      id: "challenge_conclusion",
      description: "Disagree with a teammate's conclusion. State the conclusion and your objection; they must defend it with evidence or revise it.",
      inputSchema: z.object({ to: z.string(), conclusion: z.string().min(5), objection: z.string().min(5) }),
      execute: async ({ to, conclusion, objection }, ctx) => (await collab()).askTeammate(turnOf(ctx, botId), botId, to, `Conclusion: ${conclusion}\nObjection: ${objection}`, "challenge"),
    });
    tools.delegate_task = createTool({
      id: "delegate_task",
      description: "Hand a clearly scoped piece of work to a teammate better suited to it. It becomes a tracked task on the plan. Give the full brief: what to produce and what you already know.",
      inputSchema: z.object({ to: z.string().describe("The teammate's @handle or name"), task: z.string().min(10), reason: z.string().nullable() }),
      execute: async ({ to, task, reason }, ctx) => (await collab()).delegate(turnOf(ctx, botId), botId, to, task, reason ?? ""),
    });
    tools.share_finding = createTool({
      id: "share_finding",
      description: "Post a finding or intermediate result to the room's shared memory so teammates can build on it. Include the source.",
      inputSchema: z.object({ title: z.string().min(3), content: z.string().min(5), source: z.string().nullable().describe("URL or file the finding came from") }),
      execute: async ({ title, content, source }, ctx) => (await collab()).shareFinding(turnOf(ctx, botId), botId, title, content, source ?? undefined),
    });
    capabilities.push(
      "Work with teammates: ask_teammate for a question, delegate_task to hand off work, request_verification to have something checked, challenge_conclusion to disagree with evidence, share_finding to post results to the room. Use these sparingly: there is a budget per plan, and you may not delegate work back to whoever gave it to you.",
    );
  }

  if (bot.role === "chief") {
    tools.create_agent = createTool({
      id: "create_agent",
      description: "Create a new agent when no existing teammate has a capability the work needs. Describe the role in plain language.",
      inputSchema: z.object({ description: z.string().min(10).describe("What the agent should do, e.g. 'a legal reviewer who checks contracts for risky clauses'") }),
      execute: async ({ description }) => {
        const { createAgentFromDescription } = await import("./factory");
        const created = await createAgentFromDescription(description, "chief");
        return { created: true, name: created.name, handle: created.handle, title: created.title };
      },
    });
    tools.schedule_workflow = createTool({
      id: "schedule_workflow",
      description: "Create a recurring workflow. schedule examples: 'every 60 minutes', 'daily 09:00', 'weekly monday 09:00'.",
      inputSchema: z.object({ name: z.string().min(3), instruction: z.string().min(10), schedule: z.string() }),
      execute: async ({ name, instruction, schedule }, ctx) => {
        const { createWorkflow, parseSchedule } = await import("./workflows");
        const turn = turnOf(ctx, botId);
        const workflow = await createWorkflow({ name, instruction, schedule: parseSchedule(schedule), conversationId: turn.conversationId });
        return { created: true, id: workflow.id, nextRunAt: workflow.nextRunAt };
      },
    });
    capabilities.push("As Chief of Staff you can create a new agent (create_agent) and schedule a recurring workflow (schedule_workflow).");
  }

  return { tools, capabilities };
}
