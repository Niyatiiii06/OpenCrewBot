import "./setup-env";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/lib/shared/types";
import { OUTBOX_DIR } from "@/lib/server/config";
import { analyze, chartSvg, parseCsv } from "@/lib/server/data-analysis";
import { listApprovals, listAudit, normalizeBot } from "@/lib/server/db";
import { inspectRepo, parseRepo } from "@/lib/server/integrations";
import { appendScope, readScope, sharedMemoryForPrompt, writeScope } from "@/lib/server/memory-files";
import { decide, gate, releaseGate } from "@/lib/server/permissions";
import { planByRules } from "@/lib/server/planner";
import { listSkills, saveSkill, selectSkills } from "@/lib/server/skills";
import { nextRun, parseSchedule } from "@/lib/server/workflows";
import "@/lib/server/native-tools";

function bot(patch: Partial<Bot>): Bot {
  return normalizeBot({
    id: patch.name?.toLowerCase() ?? "b1",
    name: "Bot",
    handle: "bot",
    title: "",
    description: "",
    instructions: "",
    emoji: "",
    color: "#000",
    model: "groq/openai/gpt-oss-120b",
    tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true },
    connections: [],
    approval: "ask",
    pinned: false,
    createdAt: new Date().toISOString(),
    ...patch,
  } as Bot);
}

const turn = (id: string) => ({ conversationId: "room:test", botId: id, actions: 0, toolCallId: `call-${Math.random()}` });
const email = { to: "someone@example.com", subject: "Hello", body: "Test body" };

describe("permission levels", () => {
  it("Ask first: an external action always asks", () => {
    expect(decide(bot({ approval: "ask" }), "send_email", email, 0).policy).toBe("ask");
  });
  it("Controlled: only pre-approved recipients run without asking, within the limit", () => {
    const b = bot({ approval: "controlled", limits: { maxActionsPerRun: 1, allowedEmailDomains: ["meetuniversity.com"], allowedRepos: [] } });
    expect(decide(b, "send_email", email, 0).policy).toBe("ask");
    expect(decide(b, "send_email", { ...email, to: "a@meetuniversity.com" }, 0).policy).toBe("allow");
    expect(decide(b, "send_email", { ...email, to: "a@meetuniversity.com" }, 1).policy).toBe("ask");
  });
  it("Full access: runs without asking; a tool-level block still wins", () => {
    expect(decide(bot({ approval: "full" }), "send_email", email, 0).policy).toBe("allow");
    expect(decide(bot({ approval: "full", toolPolicy: { send_email: "deny" } }), "send_email", email, 0).policy).toBe("deny");
  });
  it("read-only tools never ask", () => {
    expect(decide(bot({ approval: "ask" }), "web_search", { query: "x" }, 0).policy).toBe("allow");
  });
});

describe("approval enforcement", () => {
  it("a rejected action is never executed and is recorded", async () => {
    const b = bot({ name: "Rejector", approval: "ask" });
    const execute = vi.fn();
    const pending = gate(b, "send_email", email, turn(b.id));
    await new Promise((r) => setTimeout(r, 100));
    const approval = (await listApprovals()).find((a) => a.botId === b.id && a.status === "pending");
    expect(approval).toBeTruthy();
    expect(approval!.preview).toContain("someone@example.com");
    releaseGate(approval!.id, "rejected");
    const result = await pending;
    if (result.allowed) execute();
    expect(result.allowed).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(OUTBOX_DIR) ? readdirSync(OUTBOX_DIR) : []).toHaveLength(0);
  });
  it("a blocked tool is refused without asking and logged", async () => {
    const b = bot({ name: "Blocked", approval: "full", toolPolicy: { send_email: "deny" } });
    const result = await gate(b, "send_email", email, turn(b.id));
    expect(result.allowed).toBe(false);
    expect((await listAudit()).some((e) => e.event === "blocked" && e.botId === b.id)).toBe(true);
  });
  it("stopping the run cancels a waiting approval", async () => {
    const b = bot({ name: "Stopper", approval: "ask" });
    const abort = new AbortController();
    const pending = gate(b, "send_email", email, { ...turn(b.id), signal: abort.signal });
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    expect((await pending).outcome).toBe("cancelled");
  });
});

describe("rule planner", () => {
  const team = [
    bot({ id: "chief", name: "Chief", role: "chief" }),
    bot({ id: "scout", name: "Scout", title: "Research", tools: { webSearch: true, memory: true, codeMode: false, browser: false, askUser: true } }),
    bot({ id: "dex", name: "Dex", title: "Data analysis", tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true, dataAnalysis: true } }),
    bot({ id: "quill", name: "Quill", title: "Content", skills: ["campaign-strategy"] }),
    bot({ id: "vera", name: "Vera", title: "Review and QA" }),
    bot({ id: "echo", name: "Echo", title: "Outreach", tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true, email: true } }),
  ];
  it("splits a mixed request into parallel gathering, dependent writing, review, then a gated action", () => {
    const plan = planByRules("Research competitors, analyse the sales spreadsheet, write a 30-day campaign and email it to a@b.com", team);
    const by = (title: string) => plan.tasks.find((t) => t.title === title)!;
    expect(by("Research the competitors").agentId).toBe("scout");
    expect(by("Analyse the data").agentId).toBe("dex");
    expect(by("Research the competitors").dependsOn).toEqual([]);
    expect(by("Analyse the data").dependsOn).toEqual([]);
    expect(by("Write the campaign").dependsOn).toHaveLength(2);
    expect(by("Verify the work").agentId).toBe("vera");
    expect(by("Send the email").needsApproval).toBe(true);
    expect(by("Send the email").dependsOn).toContain(by("Verify the work").ref);
  });
  it("answers a short question directly instead of planning", () => {
    expect(planByRules("hello, who are you?", team).direct).toBe(true);
  });
  it("asks for a new agent when nobody has the tool", () => {
    const plan = planByRules("Inspect the repository github.com/a/b", team);
    expect(plan.newAgents.length).toBe(1);
  });
});

describe("data analysis", () => {
  it("parses quoted CSV", () => {
    expect(parseCsv('a,b\n"x, y",2\n')).toEqual([["a", "b"], ["x, y", "2"]]);
  });
  it("computes the funnel and totals of the sample file", () => {
    const a = analyze({ file: "meetuniversity_sales_sample.csv" });
    expect(a.rows).toBe(600);
    expect(a.funnel!.stages[0].reached).toBe(600);
    const reached = a.funnel!.stages.map((s) => s.reached);
    expect([...reached].sort((x, y) => y - x)).toEqual(reached);
    expect(a.markdown).toContain("Enrolled");
  });
  it("draws an SVG chart", () => {
    expect(chartSvg({ title: "T", type: "bar", labels: ["a", "b"], values: [1, 2] })).toContain("<svg");
  });
  it("refuses files outside the data folders", () => {
    expect(() => analyze({ file: "../../.env" })).toThrow();
  });
});

describe("memory", () => {
  it("records who saved what and why, and edits are what agents read next", () => {
    appendScope("user", "Prefers short answers", { by: "Quill", why: "stated in chat", source: "dm:quill" });
    expect(readScope("user")).toMatch(/Prefers short answers _\(\d{4}-\d{2}-\d{2}, by Quill: stated in chat\)_/);
    expect(sharedMemoryForPrompt()).toContain("Prefers short answers");
    writeScope("user", "# User preferences\n\n- Prefers long, detailed answers\n", { by: "You", why: "changed my mind", source: "memory manager" });
    const prompt = sharedMemoryForPrompt();
    expect(prompt).toContain("long, detailed answers");
    expect(prompt).not.toContain("short answers");
  });
  it("never stores secrets", () => {
    appendScope("project", "the key is sk-abcdefghijklmnopqrstuvwxyz123456", { by: "Bot", why: "x", source: "y" });
    expect(readScope("project")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("skills", () => {
  it("ships at least eight skills", () => {
    expect(listSkills().length).toBeGreaterThanOrEqual(8);
  });
  it("picks skills by the words in the task, and loads a new skill without a restart", () => {
    expect(selectSkills("compare our pricing against competitor offers").map((s) => s.id)).toContain("competitor-analysis");
    saveSkill({ name: "Visa checklist", description: "Build a visa document checklist", triggers: ["visa checklist"], tools: [], output: "A checklist", body: "List every document." });
    expect(selectSkills("make a visa checklist for the UK").map((s) => s.id)).toContain("visa-checklist");
  });
});

describe("workflow schedules", () => {
  it("parses plain-language schedules", () => {
    expect(parseSchedule("every 30 minutes")).toEqual({ type: "interval", minutes: 30 });
    expect(parseSchedule("daily 09:00")).toEqual({ type: "daily", time: "09:00" });
    expect(parseSchedule("weekly monday 10:30")).toEqual({ type: "weekly", day: 1, time: "10:30" });
    expect(parseSchedule("manual")).toEqual({ type: "manual" });
  });
  it("computes the next run", () => {
    const from = new Date(2026, 0, 5, 10, 0, 0);
    expect(new Date(nextRun({ type: "interval", minutes: 30 }, from)!).getTime() - from.getTime()).toBe(30 * 60_000);
    expect(new Date(nextRun({ type: "daily", time: "09:00" }, from)!).getDate()).toBe(6);
    expect(nextRun({ type: "manual" }, from)).toBeUndefined();
  });
});

describe("GitHub integration (API stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("normalises repository names", () => {
    expect(parseRepo("https://github.com/Studio1-OSS/OpenCrewBot/tree/main")).toBe("Studio1-OSS/OpenCrewBot");
  });
  it("reports structural findings from what the API returns", async () => {
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/repos/acme/app") return json({ full_name: "acme/app", html_url: "https://github.com/acme/app", description: "Demo", default_branch: "main", stargazers_count: 1, forks_count: 0, open_issues_count: 1, license: null, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" });
      if (path.includes("/git/trees/")) return json({ tree: [{ path: "package.json", type: "blob", size: 100 }, { path: "src/index.ts", type: "blob", size: 400 }, { path: ".env", type: "blob", size: 20 }], truncated: false });
      if (path.endsWith("/languages")) return json({ TypeScript: 1000 });
      if (path.endsWith("/commits")) return json([{ sha: "abc1234", commit: { message: "init", author: { name: "A", date: "2026-01-01T00:00:00Z" } } }]);
      if (path.endsWith("/issues")) return json([{ number: 1, title: "Bug", labels: [{ name: "bug" }], created_at: "2026-01-02T00:00:00Z" }]);
      if (path.endsWith("/pulls")) return json([]);
      if (path.endsWith("/contents/package.json")) return json({ content: Buffer.from(JSON.stringify({ dependencies: { next: "16.0.0" }, scripts: {} })).toString("base64"), encoding: "base64", size: 60, html_url: "x" });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    const r = await inspectRepo("acme/app");
    expect(r.repo).toBe("acme/app");
    const issues = r.findings.map((f) => f.issue);
    expect(issues).toContain("No automated tests");
    expect(issues).toContain("No licence");
    expect(issues).toContain("Environment file committed");
    expect(r.issues[0].title).toBe("Bug");
    expect(r.markdown).toContain("acme/app");
  });
});
