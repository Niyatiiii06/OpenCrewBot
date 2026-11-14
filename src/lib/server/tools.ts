// The tools a bot gets, from its settings. Names are short snake_case words
// because open models pick tools by name more reliably that way.
import type { ToolsInput } from "@mastra/core/agent";
import { createCodeMode } from "@mastra/core/tools";
import type { ToolCategory } from "@mastra/core/agent-controller";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import type { Bot, Source } from "@/lib/shared/types";
import { keys } from "./config";
import { mcpServerNames } from "./connectors";
import { buildNativeTools } from "./native-tools";
import { TOOL_META } from "./permissions";

export const CODE_MODE_TOOL = "execute_typescript";

export interface BotToolset {
  tools: ToolsInput;
  /** Extra prompt text the tools need (Code Mode's function stubs). */
  instructions: string[];
  /** What the bot can do, in words, for its own system prompt. */
  capabilities: string[];
}

export function buildTools(bot: Bot): BotToolset {
  const tools: ToolsInput = {};
  const instructions: string[] = [];
  const capabilities: string[] = [];

  // 2.0 tools: scoped memory, skills, data analysis, GitHub, email, Slack, Notion,
  // collaboration, and web search (Tavily when a key is set, keyless engines otherwise).
  const native = buildNativeTools(bot);
  Object.assign(tools, native.tools);
  capabilities.push(...native.capabilities);
  if (bot.tools.codeMode) {
    // The program runs in a QuickJS (WebAssembly) isolate with no filesystem or
    // network; its only reach is the tools passed here, bridged back to the host.
    const reachable = { ...tools };
    const codeMode = createCodeMode({ tools: reachable, timeout: 60_000 }, new QuickJsCodeModeTransport({ memoryLimitMb: 128 }));
    tools[CODE_MODE_TOOL] = codeMode.tool;
    instructions.push(codeMode.instructions);
    capabilities.push(
      `Run TypeScript with ${CODE_MODE_TOOL} when a question needs several tool calls, filtering, or exact arithmetic; call the other tools from inside it with Promise.all.`,
    );
  }
  if (bot.tools.browser && keys.browserbase()) {
    capabilities.push(
      "Drive a real cloud browser with the browser_* tools for pages that need clicks, forms or JavaScript. Start with browser_goto, then browser_snapshot to get element refs. The person can watch you live. Prefer read_page for plain reading; it's faster.",
    );
  } else if (bot.tools.browser) {
    capabilities.push("The browser is switched on for you, but no Browserbase key is set yet, so browsing will fail. Say so if asked.");
  }
  return { tools, instructions, capabilities };
}

/** Which approval policy a tool falls under. Read and memory tools never ask;
 * acting in the browser does, unless the bot has Full access. */
/** MCP tool names that only look things up. A heuristic over the tool's own name:
 * anything that doesn't read clearly as a lookup asks first. */
const READ_ONLY_VERB = /^(get|list|search|read|fetch|find|view|show|describe|lookup|query)(_|$)/;

export function toolCategory(toolName: string): ToolCategory | null {
  if (["web_search", "read_page", "crawl_site", "ask_user", CODE_MODE_TOOL].includes(toolName)) return "read";
  // Composio: looking up actions is free; running them ("multi execute", the remote workbench) asks.
  if (toolName.startsWith("COMPOSIO_")) {
    return /SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS/.test(toolName) ? "read" : "mcp";
  }
  if (toolName.startsWith("mcp_")) {
    const action = toolName.split("_").slice(2).join("_");
    return READ_ONLY_VERB.test(action) ? "read" : "mcp";
  }
  if (toolName.startsWith("memory_")) return "edit";
  // External native tools ask through the approval gate inside the tool, so Mastra lets them start.
  const meta = TOOL_META.get(toolName);
  if (meta) return meta.risk === "read" ? "read" : meta.risk === "local" ? "edit" : "other";
  if (toolName.startsWith("browser_")) {
    return /snapshot|screenshot|scroll|wait|tabs|close|get_|read|extract|console/.test(toolName) ? "read" : "execute";
  }
  return "other";
}

// ── how tool calls look in chat ─────────────────────────────────────────

function host(url: unknown): string {
  try {
    return new URL(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

/** "SLACK_SEND_MESSAGE" → "Slack: send message" */
function composioAction(slug: string): string {
  const [app, ...rest] = String(slug).toLowerCase().split("_");
  return `${app.charAt(0).toUpperCase()}${app.slice(1)}: ${rest.join(" ")}`;
}

export function toolLabel(name: string, args: unknown): { label: string; detail?: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name.startsWith("COMPOSIO_")) {
    if (/SEARCH_TOOLS/.test(name)) {
      const queries = Array.isArray(a.queries) ? a.queries.map((q) => (q as { use_case?: string })?.use_case ?? q) : [];
      return { label: "Looked up app actions", detail: queries.map(String).join(", ") || undefined };
    }
    if (/MULTI_EXECUTE/.test(name)) {
      const runs = Array.isArray(a.tools) ? a.tools.map((t) => composioAction((t as { tool_slug?: string })?.tool_slug ?? "")) : [];
      return { label: "Used connected apps", detail: runs.join(", ") || undefined };
    }
    return { label: composioAction(name.replace(/^COMPOSIO_/, "")) };
  }
  if (name.startsWith("mcp_")) {
    const [, id, ...rest] = name.split("_");
    return { label: `${mcpServerNames.get(id) ?? "MCP"}: ${rest.join(" ")}` };
  }
  switch (name) {
    case "web_search":
      return { label: "Searched the web", detail: String(a.query ?? "") };
    case "read_page": {
      const urls = Array.isArray(a.urls) ? a.urls : [a.urls ?? a.url];
      return { label: "Read", detail: urls.map(host).join(", ") };
    }
    case "crawl_site":
      return { label: "Crawled", detail: host(a.url) };
    case "memory_add":
      return { label: "Saved to memory", detail: String(a.note ?? "") };
    case "memory_edit":
      return { label: "Updated memory" };
    case CODE_MODE_TOOL:
      return { label: "Ran code" };
    case "use_skill":
      return { label: "Loaded skill", detail: String(a.skill ?? "") };
    case "analyze_spreadsheet":
      return { label: "Analysed spreadsheet", detail: String(a.file ?? "") };
    case "make_chart":
      return { label: "Drew chart", detail: String(a.title ?? "") };
    case "save_artifact":
      return { label: "Saved deliverable", detail: String(a.title ?? "") };
    case "github_inspect_repo":
      return { label: "Inspected repository", detail: String(a.repo ?? "") };
    case "github_read_file":
      return { label: "Read file on GitHub", detail: `${a.repo ?? ""} ${a.path ?? ""}`.trim() };
    case "github_create_issue":
      return { label: "Open GitHub issue", detail: `${a.repo ?? ""}: ${a.title ?? ""}` };
    case "send_email":
      return { label: "Send email", detail: `to ${a.to ?? ""}: ${a.subject ?? ""}` };
    case "slack_post":
      return { label: "Post to Slack", detail: String(a.text ?? "").slice(0, 80) };
    case "notion_create_page":
      return { label: "Create Notion page", detail: String(a.title ?? "") };
    case "ask_teammate":
      return { label: "Asked teammate", detail: `@${a.to ?? ""}` };
    case "request_verification":
      return { label: "Requested verification", detail: a.to ? `@${a.to}` : undefined };
    case "challenge_conclusion":
      return { label: "Challenged a conclusion", detail: `@${a.to ?? ""}` };
    case "delegate_task":
      return { label: "Delegated", detail: `@${a.to ?? ""}: ${String(a.task ?? "").slice(0, 80)}` };
    case "share_finding":
      return { label: "Shared finding", detail: String(a.title ?? "") };
    case "create_agent":
      return { label: "Created agent", detail: String(a.description ?? "").slice(0, 80) };
    case "schedule_workflow":
      return { label: "Scheduled workflow", detail: String(a.name ?? "") };
    case "list_data_files":
      return { label: "Listed data files" };
    case "ask_user":
      return { label: "Asked you" };
    default:
      if (name.startsWith("browser_")) {
        const action = name.slice("browser_".length).replace(/_/g, " ");
        return { label: `Browser: ${action}`, detail: a.url ? host(a.url) : undefined };
      }
      return { label: name.replace(/_/g, " ") };
  }
}

export function toolSources(result: unknown): Source[] | undefined {
  const r = result as { results?: Array<{ title?: string; url?: string }> } | null;
  if (!r || !Array.isArray(r.results)) return undefined;
  const sources = r.results
    .filter((x) => typeof x?.url === "string")
    .map((x) => ({ title: x.title || host(x.url), url: x.url as string }));
  return sources.length ? sources.slice(0, 8) : undefined;
}

export function toolPreview(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.slice(0, 400);
  const r = result as Record<string, unknown>;
  if (typeof r.message === "string" && r.message) return r.message.slice(0, 400);
  if (typeof r.answer === "string" && r.answer) return r.answer.slice(0, 400);
  if (typeof r.markdown === "string" && r.markdown) return r.markdown.slice(0, 400);
  if (typeof r.error === "string") return r.error.slice(0, 400);
  if (typeof r.reason === "string") return r.reason.slice(0, 400);
  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return undefined;
  }
}
