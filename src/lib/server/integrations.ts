// Integrations with outside services. The original app reached Slack, GitHub,
// Gmail and Notion only through Composio (one paid-tier key for everything) or a
// remote MCP server. This module adds direct, free connections:
//
//   GitHub  REST API. Reading public repositories needs no token at all.
//   Gmail   SMTP with an app password.
//   Slack   an incoming webhook.
//   Notion  an internal integration token.
//
// Each function reports honestly whether it reached the real service. When a
// service is not connected, the action is written to data/outbox and returned
// with `simulated: true`, and every screen that shows it labels it SIMULATED.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IntegrationInfo } from "@/lib/shared/types";
import { OUTBOX_DIR, keys } from "./config";
import { getSetting, setSetting } from "./db";
import { getSecret, hasSecret, secretSource } from "./secrets";
import { listServers } from "./mcp-servers";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(cut at ${max} characters)` : text);

function toOutbox(kind: string, content: string, ext = "json"): string {
  const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}-${randomUUID().slice(0, 6)}.${ext}`;
  writeFileSync(join(OUTBOX_DIR, file), content);
  return file;
}

// ── GitHub ──────────────────────────────────────────────────────────────

const GH = "https://api.github.com";
const GH_TOKEN_ALIASES = ["GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"];

/** "https://github.com/owner/repo/…" or "owner/repo" → "owner/repo". */
export function parseRepo(input: string): string {
  const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error(`"${input}" is not a GitHub repository. Use owner/name, e.g. Studio1-OSS/OpenCrewBot.`);
  return `${owner}/${repo}`;
}

async function gh<T>(path: string, init?: RequestInit, anonymous = false): Promise<T> {
  const token = anonymous ? undefined : await getSecret("GITHUB_TOKEN", GH_TOKEN_ALIASES);
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenCrewBot",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    // A bad or expired token should not stop public reads: try once without it.
    if (res.status === 401 && token && (init?.method ?? "GET") === "GET") return gh<T>(path, init, true);
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub's hourly limit for requests without a token is used up. Add a GitHub token in Integrations to raise it.");
    }
    throw new Error(`GitHub ${res.status}: ${body.message ?? res.statusText}`);
  }
  return (await res.json()) as T;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface RepoFinding {
  severity: "high" | "medium" | "low";
  area: string;
  issue: string;
  evidence: string;
  fix: string;
}

export interface RepoInspection {
  repo: string;
  url: string;
  description: string;
  defaultBranch: string;
  stars: number;
  openIssues: number;
  license: string | null;
  pushedAt: string;
  languages: Record<string, number>;
  fileCount: number;
  topLevel: string[];
  dependencies: { file: string; count: number; names: string[] }[];
  recentCommits: { sha: string; date: string; author: string; message: string }[];
  issues: { number: number; title: string; labels: string[]; createdAt: string }[];
  pullRequests: { number: number; title: string; createdAt: string }[];
  /** Checks computed from the file tree and metadata. Each one names its evidence. */
  findings: RepoFinding[];
  readmeExcerpt: string;
  markdown: string;
  live: true;
}

/** Read a repository's metadata, file tree, dependencies, recent commits, open issues and
 * pull requests, then run structural checks on what was read. All from GitHub's REST API. */
export async function inspectRepo(input: string): Promise<RepoInspection> {
  const repo = parseRepo(input);
  const meta = await gh<{ description: string | null; default_branch: string; stargazers_count: number; open_issues_count: number; license: { spdx_id: string } | null; pushed_at: string; html_url: string; archived: boolean }>(`/repos/${repo}`);
  const branch = meta.default_branch;
  const [languages, tree, commits, issuesRaw, pulls, readme] = await Promise.all([
    gh<Record<string, number>>(`/repos/${repo}/languages`).catch(() => ({})),
    gh<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`).catch(() => ({ tree: [] as TreeEntry[], truncated: false })),
    gh<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(`/repos/${repo}/commits?per_page=10`).catch(() => []),
    gh<{ number: number; title: string; labels: { name: string }[]; created_at: string; pull_request?: unknown }[]>(`/repos/${repo}/issues?state=open&per_page=20`).catch(() => []),
    gh<{ number: number; title: string; created_at: string }[]>(`/repos/${repo}/pulls?state=open&per_page=10`).catch(() => []),
    readFile(repo, "README.md").catch(() => null),
  ]);

  const files = tree.tree.filter((e) => e.type === "blob");
  const paths = files.map((f) => f.path);
  const has = (pattern: RegExp) => paths.some((p) => pattern.test(p));
  const count = (pattern: RegExp) => paths.filter((p) => pattern.test(p)).length;

  const dependencies: RepoInspection["dependencies"] = [];
  let pkgNoTestScript = false;
  if (paths.includes("package.json")) {
    const pkg = await readFile(repo, "package.json").catch(() => null);
    if (pkg) {
      try {
        const json = JSON.parse(pkg.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
        const names = [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})];
        dependencies.push({ file: "package.json", count: names.length, names: names.slice(0, 40) });
        if (!json.scripts?.test) pkgNoTestScript = true;
      } catch {
        // not valid JSON; leave dependencies empty
      }
    }
  }
  if (paths.includes("requirements.txt")) {
    const req = await readFile(repo, "requirements.txt").catch(() => null);
    if (req) {
      const names = req.content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      dependencies.push({ file: "requirements.txt", count: names.length, names: names.slice(0, 40) });
    }
  }

  const findings: RepoFinding[] = [];
  const sourceFiles = count(/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs)$/);
  const testFiles = count(/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/);
  if (sourceFiles > 0 && testFiles === 0) {
    findings.push({ severity: "high", area: "Testing", issue: "No automated tests", evidence: `${sourceFiles} source files and 0 test files in the tree${pkgNoTestScript ? "; package.json has no \"test\" script" : ""}`, fix: "Add a test runner and cover the core logic first; run it in CI." });
  } else if (sourceFiles > 0 && testFiles / sourceFiles < 0.1) {
    findings.push({ severity: "medium", area: "Testing", issue: "Thin test coverage", evidence: `${testFiles} test files for ${sourceFiles} source files`, fix: "Add tests for the modules that change most often." });
  }
  if (!has(/^\.github\/workflows\/.+\.ya?ml$/) && !has(/^(\.gitlab-ci\.yml|\.circleci\/|azure-pipelines\.yml|Jenkinsfile)/)) {
    findings.push({ severity: "medium", area: "Automation", issue: "No continuous integration", evidence: "No .github/workflows directory or other CI configuration in the tree", fix: "Add a workflow that type-checks, lints and tests every pull request." });
  }
  const envFiles = paths.filter((p) => /(^|\/)\.env(\.[\w-]+)?$/.test(p) && !/example|sample|template/i.test(p));
  if (envFiles.length) {
    findings.push({ severity: "high", area: "Security", issue: "Environment file committed", evidence: envFiles.slice(0, 3).join(", "), fix: "Remove it from the repository, rotate any keys it held, and add it to .gitignore." });
  }
  if (!paths.includes(".gitignore")) findings.push({ severity: "low", area: "Hygiene", issue: "No .gitignore", evidence: "No .gitignore at the repository root", fix: "Add one for the project's language and tools." });
  if (!meta.license && !has(/^LICEN[SC]E/i)) findings.push({ severity: "medium", area: "Legal", issue: "No licence", evidence: "GitHub reports no licence and no LICENSE file exists", fix: "Add a licence so others know how the code may be used." });
  if (!readme) findings.push({ severity: "medium", area: "Documentation", issue: "No README", evidence: "README.md was not found", fix: "Add setup, usage and architecture notes." });
  else if (readme.content.length < 600) findings.push({ severity: "low", area: "Documentation", issue: "Very short README", evidence: `README.md is ${readme.content.length} characters`, fix: "Document setup, configuration and how to run the project." });
  if (paths.includes("package.json") && !has(/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/)) {
    findings.push({ severity: "medium", area: "Dependencies", issue: "No lockfile", evidence: "package.json exists but no lockfile is committed", fix: "Commit the lockfile so installs are reproducible." });
  }
  if (!has(/(^|\/)(eslint\.config\.[cm]?js|\.eslintrc|ruff\.toml|\.flake8|\.golangci\.yml|biome\.json)/) && !paths.includes("pyproject.toml") && sourceFiles > 0) {
    findings.push({ severity: "low", area: "Code quality", issue: "No linter configuration", evidence: "No ESLint, Ruff, Flake8, Biome or golangci configuration found", fix: "Add a linter and run it in CI." });
  }
  const big = files.filter((f) => (f.size ?? 0) > 1_000_000).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (big.length) findings.push({ severity: "low", area: "Repository size", issue: "Large files in the repository", evidence: big.slice(0, 3).map((f) => `${f.path} (${Math.round((f.size ?? 0) / 1e6)} MB)`).join(", "), fix: "Move binaries to releases or Git LFS." });
  if (!has(/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/) && !has(/^(vercel\.json|netlify\.toml|render\.yaml|fly\.toml|Procfile)$/)) {
    findings.push({ severity: "low", area: "Deployment", issue: "No deployment configuration", evidence: "No Dockerfile or platform configuration in the tree", fix: "Add one if the project is meant to be deployed." });
  }
  const stale = (Date.now() - new Date(meta.pushed_at).getTime()) / 86_400_000;
  if (stale > 365) findings.push({ severity: "medium", area: "Maintenance", issue: "No recent activity", evidence: `Last push was ${Math.round(stale)} days ago`, fix: "Confirm the project is still maintained before depending on it." });
  if (meta.archived) findings.push({ severity: "high", area: "Maintenance", issue: "Repository is archived", evidence: "GitHub marks it read-only", fix: "Use a maintained fork or alternative." });
  if (tree.truncated) findings.push({ severity: "low", area: "Inspection", issue: "File tree was truncated", evidence: "GitHub returned a partial tree for this large repository", fix: "Inspect key folders individually." });

  const issues = issuesRaw.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), createdAt: i.created_at.slice(0, 10) }));
  const pullRequests = pulls.map((p) => ({ number: p.number, title: p.title, createdAt: p.created_at.slice(0, 10) }));
  const recentCommits = commits.map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit.author.date.slice(0, 10), author: c.commit.author.name, message: c.commit.message.split("\n")[0].slice(0, 100) }));
  const topLevel = [...new Set(paths.map((p) => p.split("/")[0]))].slice(0, 40);
  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  const langLine = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, b]) => `${l} ${Math.round((100 * b) / totalBytes)}%`).join(", ");
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const markdown = [
    `**Repository:** [${repo}](${meta.html_url}) · ${meta.description ?? "no description"}`,
    `**Default branch:** ${branch} · **Stars:** ${meta.stargazers_count} · **Open issues and PRs:** ${meta.open_issues_count} · **Licence:** ${meta.license?.spdx_id ?? "none"} · **Last push:** ${meta.pushed_at.slice(0, 10)}`,
    `**Languages:** ${langLine || "unknown"} · **Files:** ${files.length} (${sourceFiles} source, ${testFiles} test)`,
    `**Top level:** ${topLevel.join(", ")}`,
    dependencies.length ? `**Dependencies:** ${dependencies.map((d) => `${d.file} (${d.count}): ${d.names.slice(0, 14).join(", ")}${d.count > 14 ? "…" : ""}`).join(" · ")}` : "",
    findings.length
      ? `**Structural checks** (computed from the file tree and metadata)\n\n| Severity | Area | Issue | Evidence | Suggested fix |\n| --- | --- | --- | --- | --- |\n${findings.map((f) => `| ${f.severity} | ${f.area} | ${f.issue} | ${f.evidence.replace(/\|/g, "/")} | ${f.fix} |`).join("\n")}`
      : "**Structural checks:** no problems found by the automated checks.",
    recentCommits.length ? `**Recent commits**\n${recentCommits.slice(0, 6).map((c) => `- ${c.date} ${c.sha} ${c.message} (${c.author})`).join("\n")}` : "",
    issues.length ? `**Open issues**\n${issues.slice(0, 8).map((i) => `- #${i.number} ${i.title}${i.labels.length ? ` [${i.labels.join(", ")}]` : ""}`).join("\n")}` : "**Open issues:** none",
    pullRequests.length ? `**Open pull requests**\n${pullRequests.slice(0, 6).map((p) => `- #${p.number} ${p.title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    repo,
    url: meta.html_url,
    description: meta.description ?? "",
    defaultBranch: branch,
    stars: meta.stargazers_count,
    openIssues: meta.open_issues_count,
    license: meta.license?.spdx_id ?? null,
    pushedAt: meta.pushed_at,
    languages,
    fileCount: files.length,
    topLevel,
    dependencies,
    recentCommits,
    issues,
    pullRequests,
    findings,
    readmeExcerpt: clip(readme?.content ?? "", 1500),
    markdown,
    live: true,
  };
}

export async function readFile(repoInput: string, path: string, ref?: string): Promise<{ repo: string; path: string; content: string; size: number; url: string }> {
  const repo = parseRepo(repoInput);
  const clean = path.replace(/^\/+/, "");
  const file = await gh<{ content?: string; encoding?: string; size: number; html_url: string; type?: string } | unknown[]>(
    `/repos/${repo}/contents/${clean.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
  );
  if (Array.isArray(file)) {
    const names = (file as { name: string; type: string }[]).map((f) => `${f.name}${f.type === "dir" ? "/" : ""}`).join("\n");
    return { repo, path: clean, content: `Directory listing:\n${names}`, size: names.length, url: `https://github.com/${repo}/tree/HEAD/${clean}` };
  }
  const f = file as { content?: string; encoding?: string; size: number; html_url: string };
  const content = f.encoding === "base64" && f.content ? Buffer.from(f.content, "base64").toString("utf8") : (f.content ?? "");
  return { repo, path: clean, content: clip(content, 14_000), size: f.size, url: f.html_url };
}

export interface ActionResult {
  ok: boolean;
  /** True when the real service was not reached and the action was only recorded locally. */
  simulated: boolean;
  detail: string;
  url?: string;
  outboxFile?: string;
}

export async function createIssue(repoInput: string, title: string, body: string, labels: string[] = []): Promise<ActionResult> {
  const repo = parseRepo(repoInput);
  if (!(await hasSecret("GITHUB_TOKEN", GH_TOKEN_ALIASES))) {
    const outboxFile = toOutbox("github-issue", JSON.stringify({ simulated: true, repo, title, body, labels }, null, 2));
    return { ok: true, simulated: true, detail: `No GitHub token is set, so the issue "${title}" for ${repo} was NOT created on GitHub. It was saved to data/outbox/${outboxFile}.`, outboxFile };
  }
  const issue = await gh<{ html_url: string; number: number }>(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels }) });
  return { ok: true, simulated: false, detail: `Created issue #${issue.number} in ${repo}.`, url: issue.html_url };
}

// ── Gmail (SMTP) ────────────────────────────────────────────────────────

const MAIL_USER = ["GMAIL_USER", ["SMTP_USER"]] as const;
const MAIL_PASS = ["GMAIL_APP_PASSWORD", ["SMTP_PASSWORD"]] as const;

async function mailer() {
  const user = await getSecret(MAIL_USER[0], [...MAIL_USER[1]]);
  const pass = await getSecret(MAIL_PASS[0], [...MAIL_PASS[1]]);
  if (!user || !pass) return null;
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user, pass: pass.replace(/\s+/g, "") },
  });
  return { transport, user };
}

export async function sendEmail(to: string, subject: string, body: string): Promise<ActionResult> {
  const recipients = to.split(/[,;\s]+/).map((r) => r.trim()).filter(Boolean);
  if (!recipients.length || recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) throw new Error(`"${to}" is not a valid list of email addresses.`);
  const mail = await mailer();
  if (!mail) {
    const outboxFile = toOutbox("email", `X-OpenCrewBot: SIMULATED (Gmail is not connected; this email was not sent)\nTo: ${recipients.join(", ")}\nSubject: ${subject}\n\n${body}\n`, "eml");
    return { ok: true, simulated: true, detail: `Gmail is not connected, so the email to ${recipients.join(", ")} was NOT sent. It was saved to data/outbox/${outboxFile}.`, outboxFile };
  }
  const info = await mail.transport.sendMail({ from: mail.user, to: recipients.join(", "), subject, text: body });
  return { ok: true, simulated: false, detail: `Email sent from ${mail.user} to ${recipients.join(", ")} (message id ${info.messageId}).` };
}

// ── Slack (incoming webhook) ────────────────────────────────────────────

export async function slackPost(text: string): Promise<ActionResult> {
  const webhook = await getSecret("SLACK_WEBHOOK_URL");
  if (!webhook) {
    const outboxFile = toOutbox("slack", JSON.stringify({ simulated: true, text }, null, 2));
    return { ok: true, simulated: true, detail: `Slack is not connected, so the message was NOT posted. It was saved to data/outbox/${outboxFile}.`, outboxFile };
  }
  const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true, simulated: false, detail: "Message posted to Slack." };
}

// ── Notion ──────────────────────────────────────────────────────────────

function notionBlocks(markdown: string) {
  return markdown.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 90).map((p) => {
    const heading = p.match(/^(#{1,3})\s+(.*)$/);
    const text = [{ type: "text", text: { content: (heading ? heading[2] : p).slice(0, 1900) } }];
    if (heading) {
      const type = `heading_${heading[1].length}` as "heading_1";
      return { object: "block", type, [type]: { rich_text: text } };
    }
    return { object: "block", type: "paragraph", paragraph: { rich_text: text } };
  });
}

export async function notionCreatePage(title: string, content: string): Promise<ActionResult> {
  const token = await getSecret("NOTION_TOKEN", ["NOTION_API_KEY"]);
  const parent = await getSecret("NOTION_PARENT_PAGE_ID");
  if (!token || !parent) {
    const outboxFile = toOutbox("notion-page", `# ${title}\n\n<!-- SIMULATED: Notion is not connected; this page was not created -->\n\n${content}\n`, "md");
    return { ok: true, simulated: true, detail: `Notion is not connected, so the page "${title}" was NOT created. It was saved to data/outbox/${outboxFile}.`, outboxFile };
  }
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({
      parent: { page_id: parent.replace(/-/g, "").replace(/^.*([0-9a-f]{32}).*$/i, "$1") },
      properties: { title: { title: [{ type: "text", text: { content: title.slice(0, 200) } }] } },
      children: notionBlocks(content),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
  if (!res.ok) throw new Error(`Notion answered ${res.status}: ${json.message ?? "unknown error"}`);
  return { ok: true, simulated: false, detail: `Created Notion page "${title}".`, url: json.url };
}

// ── web search and page reading without a key ───────────────────────────

export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** One keyless search engine: how to ask it, and how to read its answer. */
interface Engine {
  name: string;
  url: string;
  /** Sent as a form POST when set, otherwise the query goes in the URL. */
  form?: boolean;
  /** Groups: 1 = link, 2 = title, 3 = snippet (optional). */
  pattern: RegExp;
}

// Scraped pages change without notice, so several engines are tried in turn and
// the first that answers wins. Set TAVILY_API_KEY for a supported search API.
const ENGINES: Engine[] = [
  {
    name: "DuckDuckGo Lite",
    url: "https://lite.duckduckgo.com/lite/",
    form: true,
    pattern: /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,800}?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g,
  },
  {
    name: "DuckDuckGo HTML",
    url: "https://html.duckduckgo.com/html/",
    form: true,
    pattern: /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,
  },
  {
    name: "Mojeek",
    url: "https://www.mojeek.com/search?q=",
    pattern: /<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]{0,600}?<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/g,
  },
  {
    name: "Brave",
    url: "https://search.brave.com/search?q=",
    pattern: /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]{0,200}?<div[^>]+class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]{0,600}?<div[^>]+class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
  },
];

/** Pull the real destination out of a results-page link. */
function resolveLink(raw: string): string | null {
  let url = decode(raw);
  const redirect = url.match(/[?&](?:uddg|url|u)=([^&]+)/);
  if (redirect) {
    try {
      url = decodeURIComponent(redirect[1]);
    } catch {
      return null;
    }
  }
  if (url.startsWith("//")) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return null;
  if (/duckduckgo\.com\/y\.js|google\.com\/(?:search|url)|mojeek\.com\/search|search\.brave\.com\/search|bing\.com\/search/i.test(url)) return null;
  return url;
}

async function askEngine(engine: Engine, query: string, max: number): Promise<SearchHit[]> {
  const target = engine.form ? engine.url : engine.url + encodeURIComponent(query);
  const res = await fetch(target, {
    method: engine.form ? "POST" : "GET",
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      ...(engine.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: engine.form ? new URLSearchParams({ q: query }).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(engine.pattern)) {
    const url = resolveLink(m[1]);
    const title = decode(m[2] ?? "");
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, content: decode(m[3] ?? "").slice(0, 400) });
    if (hits.length >= max) break;
  }
  return hits;
}

/** Search with Tavily, which is a supported API rather than a scraped page. */
async function tavilySearch(query: string, max: number, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: Math.min(max, 10), search_depth: "basic" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401) throw new Error("Tavily rejected the key (401). Check TAVILY_API_KEY in .env.");
    if (res.status === 429 || res.status === 432) throw new Error("Tavily is out of free credits for this month (429).");
    throw new Error(`Tavily answered ${res.status}. ${body}`);
  }
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[]; answer?: string };
  return (body.results ?? [])
    .filter((r) => r.url)
    .slice(0, max)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: (r.content ?? "").slice(0, 400) }));
}

/** Search the web. Uses Tavily when TAVILY_API_KEY is set; otherwise tries the
 * keyless engines in turn. Throws when nothing works, so an agent reports that
 * rather than assuming the web holds nothing on the subject. */
export async function searchWeb(query: string, max = 6): Promise<SearchHit[]> {
  const tavily = process.env.TAVILY_API_KEY;
  if (tavily) return tavilySearch(query, max, tavily);
  const failures: string[] = [];
  for (const engine of ENGINES) {
    try {
      const hits = await askEngine(engine, query, max);
      if (hits.length) return hits;
      failures.push(`${engine.name}: nothing matched`);
    } catch (error) {
      failures.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Keyless web search is not working right now (${failures.join("; ")}). Set TAVILY_API_KEY in .env for a supported search API, then restart.`);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "[::1]" || h.startsWith("[f");
}

/** Fetch a public page and return its readable text. Addresses on this machine or a
 * private network are refused, so a prompt can't make the server read internal services. */
export async function readPage(input: string): Promise<{ url: string; title: string; text: string }> {
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHost(url.hostname)) throw new Error("Only public http(s) pages can be read.");
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenCrewBot/2.0; +https://github.com/Studio1-OSS/OpenCrewBot)", Accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${url.host} answered HTTP ${res.status}.`);
  const html = (await res.text()).slice(0, 1_500_000);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url.host);
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|iframe|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n"),
  );
  return { url: res.url || url.toString(), title, text: clip(text, 7000) };
}

// ── the Integration manager's view ──────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  secret: boolean;
  aliases?: string[];
  hint?: string;
}

const FIELDS: Record<string, FieldDef[]> = {
  github: [{ key: "GITHUB_TOKEN", label: "Personal access token", secret: true, aliases: ["GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"], hint: "Optional. Needed only to open issues or read private repositories." }],
  gmail: [
    { key: "GMAIL_USER", label: "Gmail address", secret: false, aliases: ["SMTP_USER"] },
    { key: "GMAIL_APP_PASSWORD", label: "App password", secret: true, aliases: ["SMTP_PASSWORD"], hint: "16 characters, from myaccount.google.com/apppasswords" },
  ],
  slack: [{ key: "SLACK_WEBHOOK_URL", label: "Incoming webhook URL", secret: true, hint: "From api.slack.com/apps → Incoming Webhooks" }],
  notion: [
    { key: "NOTION_TOKEN", label: "Integration token", secret: true, aliases: ["NOTION_API_KEY"] },
    { key: "NOTION_PARENT_PAGE_ID", label: "Parent page ID", secret: false, hint: "The page new pages are created under. Share it with the integration first." },
  ],
};

export function integrationFieldKeys(id: string): string[] {
  return (FIELDS[id] ?? []).map((f) => f.key);
}

async function fields(id: string): Promise<IntegrationInfo["fields"]> {
  return Promise.all((FIELDS[id] ?? []).map(async (f) => ({ key: f.key, label: f.label, secret: f.secret, hint: f.hint, set: Boolean(await secretSource(f.key, f.aliases)) })));
}

const TEST_KEY = "integrations.tests";
type Tests = Record<string, { at: string; ok: boolean; message: string }>;

export async function listIntegrations(): Promise<IntegrationInfo[]> {
  const tests = (await getSetting<Tests>(TEST_KEY)) ?? {};
  const ghToken = await hasSecret("GITHUB_TOKEN", GH_TOKEN_ALIASES);
  const mail = (await hasSecret("GMAIL_USER", ["SMTP_USER"])) && (await hasSecret("GMAIL_APP_PASSWORD", ["SMTP_PASSWORD"]));
  const slack = await hasSecret("SLACK_WEBHOOK_URL");
  const notion = (await hasSecret("NOTION_TOKEN", ["NOTION_API_KEY"])) && (await hasSecret("NOTION_PARENT_PAGE_ID"));
  const servers = await listServers();
  const list: IntegrationInfo[] = [
    {
      id: "github",
      name: "GitHub",
      description: "Inspect repositories, read files, and open issues.",
      state: "live",
      detail: ghToken ? "Live: reading and opening issues, with your token." : "Live for reading public repositories (60 requests an hour, no token). Opening issues is simulated until a token is added.",
      fields: await fields("github"),
      tools: ["github_inspect_repo", "github_read_file", "github_create_issue"],
      docsUrl: "https://github.com/settings/tokens",
    },
    {
      id: "gmail",
      name: "Gmail",
      description: "Send email from your Gmail account over SMTP.",
      state: mail ? "live" : "not-configured",
      detail: mail ? "Live: emails are really sent from your address, after approval." : "Not connected. Emails are written to data/outbox and labelled SIMULATED.",
      fields: await fields("gmail"),
      tools: ["send_email"],
      docsUrl: "https://myaccount.google.com/apppasswords",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Post messages to a Slack channel through an incoming webhook.",
      state: slack ? "live" : "not-configured",
      detail: slack ? "Live: messages are posted to your channel, after approval." : "Not connected. Posts are written to data/outbox and labelled SIMULATED.",
      fields: await fields("slack"),
      tools: ["slack_post"],
      docsUrl: "https://api.slack.com/messaging/webhooks",
    },
    {
      id: "notion",
      name: "Notion",
      description: "Create pages in your Notion workspace.",
      state: notion ? "live" : "not-configured",
      detail: notion ? "Live: pages are created under your parent page, after approval." : "Not connected. Pages are written to data/outbox and labelled SIMULATED.",
      fields: await fields("notion"),
      tools: ["notion_create_page"],
      docsUrl: "https://www.notion.so/my-integrations",
    },
    {
      id: "mcp",
      name: "MCP servers",
      description: "Any service that speaks the Model Context Protocol over HTTP.",
      state: servers.length ? "live" : "not-configured",
      detail: servers.length ? `Live: ${servers.length} server${servers.length === 1 ? "" : "s"} added (${servers.map((s) => s.name).join(", ")}). Switch them on per agent.` : "No server added yet. Add the free DeepWiki server with one click, or any server by URL.",
      fields: [],
      tools: ["mcp_*"],
      docsUrl: "https://modelcontextprotocol.io",
    },
    {
      id: "web",
      name: "Web search",
      description: "Search the web and read pages.",
      state: "live",
      detail: keys.tavily() ? "Live through Tavily (your key)." : "Live through DuckDuckGo, with no key. Add TAVILY_API_KEY to .env for richer results.",
      fields: [],
      tools: ["web_search", "read_page"],
    },
    {
      id: "composio",
      name: "Composio apps",
      description: "1,000+ apps through Composio (from the original OpenCrewBot).",
      state: keys.composio() ? "live" : "not-configured",
      detail: keys.composio() ? "Live: connect apps in Connections." : "Not configured: needs COMPOSIO_API_KEY in .env. Not required; the direct integrations above cover GitHub, Gmail, Slack and Notion.",
      fields: [],
      tools: ["COMPOSIO_*"],
      docsUrl: "https://platform.composio.dev",
    },
  ];
  return list.map((i) => ({ ...i, lastTest: tests[i.id] }));
}

/** Make one real call to the service and record what happened. */
export async function testIntegration(id: string): Promise<{ ok: boolean; message: string }> {
  let result: { ok: boolean; message: string };
  try {
    if (id === "github") {
      const token = await hasSecret("GITHUB_TOKEN", GH_TOKEN_ALIASES);
      const rate = await gh<{ rate: { limit: number; remaining: number } }>("/rate_limit");
      const who = token ? await gh<{ login: string }>("/user").catch(() => null) : null;
      result = { ok: true, message: `GitHub API reachable${who ? ` as ${who.login}` : " (no token: read-only)"}. ${rate.rate.remaining} of ${rate.rate.limit} requests left this hour.` };
    } else if (id === "gmail") {
      const mail = await mailer();
      if (!mail) result = { ok: false, message: "Add your Gmail address and an app password first." };
      else {
        await mail.transport.verify();
        result = { ok: true, message: `Signed in to Gmail SMTP as ${mail.user}. No email was sent by this test.` };
      }
    } else if (id === "slack") {
      const webhook = await getSecret("SLACK_WEBHOOK_URL");
      if (!webhook) result = { ok: false, message: "Add a webhook URL first." };
      else {
        await slackPost("OpenCrewBot connection test.");
        result = { ok: true, message: "Posted a test message to your Slack channel." };
      }
    } else if (id === "notion") {
      const token = await getSecret("NOTION_TOKEN", ["NOTION_API_KEY"]);
      if (!token) result = { ok: false, message: "Add an integration token first." };
      else {
        const res = await fetch("https://api.notion.com/v1/users/me", { headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" }, signal: AbortSignal.timeout(15_000) });
        const json = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
        result = res.ok ? { ok: true, message: `Connected to Notion as "${json.name ?? "integration"}". No page was created by this test.` } : { ok: false, message: `Notion answered ${res.status}: ${json.message ?? ""}` };
      }
    } else if (id === "web") {
      // With a Tavily key the agents use Tavily's tools, so test that; otherwise test the keyless engines.
      const tavily = process.env.TAVILY_API_KEY;
      if (tavily) {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavily}` },
          body: JSON.stringify({ query: "MeetUniversity study abroad", max_results: 3 }),
          signal: AbortSignal.timeout(20_000),
        }).catch((error: Error) => error);
        if (res instanceof Error) result = { ok: false, message: `Could not reach api.tavily.com: ${res.message}. Check your internet connection or a firewall.` };
        else {
          const body = (await res.json().catch(() => ({}))) as { results?: { url?: string }[]; detail?: unknown; error?: string };
          const detail = typeof body.detail === "string" ? body.detail : ((body.detail as { error?: string })?.error ?? body.error ?? "");
          if (!res.ok) result = { ok: false, message: `Tavily answered ${res.status}${res.status === 401 ? " (the key is wrong)" : res.status === 432 || res.status === 429 ? " (out of free credits for this month)" : ""}. ${detail}` };
          else result = { ok: Boolean(body.results?.length), message: body.results?.length ? `Tavily is working: ${body.results.length} results, first ${body.results[0].url}` : "Tavily answered but returned no results." };
        }
      } else {
        const hits = await searchWeb("MeetUniversity", 3);
        result = hits.length ? { ok: true, message: `Keyless search returned ${hits.length} results, first: ${hits[0].url}` } : { ok: false, message: "Keyless search returned no results." };
      }
    } else if (id === "mcp") {
      const servers = await listServers();
      if (!servers.length) result = { ok: false, message: "Add a server first." };
      else {
        const { testServer } = await import("./mcp-servers");
        const lines: string[] = [];
        for (const s of servers) lines.push(`${s.name}: ${await testServer(s.id).then((r) => `${r.tools} tools`).catch((e: Error) => `failed (${e.message})`)}`);
        result = { ok: !lines.some((l) => l.includes("failed")), message: lines.join("; ") };
      }
    } else result = { ok: false, message: "This integration has no test." };
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const tests = (await getSetting<Tests>(TEST_KEY)) ?? {};
  tests[id] = { at: new Date().toISOString(), ...result };
  await setSetting(TEST_KEY, tests);
  return result;
}
