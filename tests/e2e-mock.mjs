// End-to-end checks against a running app in mock mode.
//   Terminal 1:  set OPENCREWBOT_MOCK=1 and OPENCREWBOT_DATA_DIR=./data-test, then pnpm dev
//   Terminal 2:  node tests/e2e-mock.mjs
// Uses a fresh data folder so it does not touch your real chats. Prints PASS or FAIL per check.
const BASE = process.env.OPENCREWBOT_URL || "http://localhost:3000";
let failed = 0;

async function call(path, method = "GET", data) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  return res.json().catch(() => ({}));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const send = (conversation, text) => call(`/api/conversations/${encodeURIComponent(conversation)}/messages`, "POST", { text });
const messages = async (conversation) => (await call(`/api/conversations/${encodeURIComponent(conversation)}/messages`)).messages;
const pending = async () => (await call("/api/approvals")).approvals.filter((a) => a.status === "pending");

async function waitPlan(conversation, until = ["done", "failed", "cancelled"], seconds = 120, after = 0) {
  for (let i = 0; i < seconds; i++) {
    const plan = (await call("/api/plans")).plans.find((p) => p.conversationId === conversation && new Date(p.createdAt).getTime() >= after);
    if (plan && until.includes(plan.status)) return plan;
    await sleep(1000);
  }
  return null;
}
const task = (plan, title) => plan.tasks.find((t) => t.title === title);

const boot = await call("/api/bootstrap");
if (!boot.status?.mock) {
  console.log("This script expects mock mode. Start the app with OPENCREWBOT_MOCK=1.");
  process.exit(1);
}
const room = (name) => `room:${boot.rooms.find((r) => r.name === name).id}`;
const bot = (name) => boot.bots.find((b) => b.name === name);

console.log("\n# Minimums");
check("at least 8 configurable agents", boot.bots.length >= 8, `${boot.bots.length}`);
check("at least 4 rooms", boot.rooms.length >= 4, `${boot.rooms.length}`);
const { skills, tools } = await call("/api/skills");
check("at least 8 skills", skills.length >= 8, `${skills.length}`);
check("three permission levels in use", new Set(boot.bots.map((b) => b.approval)).size === 3);
check("tool catalog lists live and simulated tools", tools.some((t) => t.live) && tools.some((t) => !t.live));

console.log("\n# Plan, parallel tasks, calculations, charts");
let c = room("Sales and Data");
let t0 = Date.now();
await send(c, "Analyse the sales spreadsheet meetuniversity_sales_sample.csv and research the market for study abroad counselling");
let plan = await waitPlan(c, undefined, 120, t0);
check("plan finished", plan?.status === "done", plan?.status);
check("two tasks had no dependencies (ran in parallel)", plan.tasks.filter((t) => t.dependsOn.length === 0 && t.kind === "work").length >= 2);
check("analysis output has computed numbers", /600/.test(task(plan, "Analyse the data").output ?? ""));
check("charts were saved as files", (await call("/api/artifacts")).artifacts.some((a) => a.kind === "chart"));
check("a consolidated report was saved", Boolean(plan.artifactId));

console.log("\n# Failure recovery");
c = room("Market Intelligence");
t0 = Date.now();
await send(c, "Research competitors of MeetUniversity in study abroad counselling !fail-once:research");
plan = await waitPlan(c, undefined, 120, t0);
let research = task(plan, "Research the competitors");
check("a failed attempt was retried and then succeeded", research.attempts.length === 2 && research.attempts[0].status === "failed" && research.status === "done");
t0 = Date.now();
await sleep(1100);
await send(c, "Research competitors of MeetUniversity again !fail-always:research");
plan = await waitPlan(c, undefined, 180, t0);
research = task(plan, "Research the competitors");
check("after repeated failures the task was reassigned to another agent", Boolean(research.originalAgentId) && research.attempts.length === 3);
check("a plan with no successful work ends as failed, with the reasons", plan.status === "failed" && /503/.test(research.error ?? ""));

console.log("\n# Approval enforcement");
c = room("Engineering");
t0 = Date.now();
await send(c, "Inspect the repository github.com/Studio1-OSS/OpenCrewBot and open an issue for the most important finding");
plan = await waitPlan(c, ["awaiting-approval"], 120, t0);
check("the plan stops and waits for approval before the external action", plan?.status === "awaiting-approval");
let asks = await pending();
check("the approval shows a preview of the exact action", asks.length === 1 && /Repository: Studio1-OSS\/OpenCrewBot/.test(asks[0].preview));
const outboxBefore = (await call("/api/approvals")).audit.filter((a) => a.event === "executed").length;
await call(`/api/approvals/${asks[0].id}`, "POST", { approve: false });
plan = await waitPlan(c, undefined, 120, t0);
const log = await call("/api/approvals");
const decided = log.approvals.find((a) => a.id === asks[0].id);
check("the rejection is recorded", decided.status === "rejected" && !decided.executedAt);
check("the rejected action did NOT execute (no new 'executed' entry in the audit log)", log.audit.filter((a) => a.event === "executed").length === outboxBefore);
check("the agent's reply says it was not executed", (await messages(c)).some((m) => m.parts.some((p) => p.kind === "tool" && p.name === "github_create_issue" && p.status === "denied")));
check("a decided approval cannot be approved later", Boolean((await call(`/api/approvals/${asks[0].id}`, "POST", { approve: true })).error));

console.log("\n# Interruption with a new instruction");
c = room("Command Room");
t0 = Date.now();
await send(c, "Analyse the sales spreadsheet and email the summary to founder@meetuniversity.com");
plan = await waitPlan(c, ["awaiting-approval"], 120, t0);
await send(c, "Skip the email. Also research competitors.");
plan = await waitPlan(c, undefined, 120, t0);
check("the new instruction changed the running plan", plan.amendments.length === 1);
check("the email task was cancelled and never sent", task(plan, "Send the email").status === "cancelled" && (await call("/api/approvals")).approvals.some((a) => a.tool === "send_email" && a.status === "cancelled"));
check("a task for the new work was added and done", task(plan, "Research the competitors")?.status === "done");

console.log("\n# Memory");
const dm = `dm:${bot("Quill").id}`;
await send(dm, "remember that I prefer answers under 100 words with a table");
await sleep(5000);
const memory = await call("/api/memory/user");
check("the preference was saved to shared memory", /under 100 words/.test(memory.content));
check("provenance is recorded (who, why, where)", memory.log.some((l) => l.by === "Quill" && l.why && l.source));
await call("/api/memory/user", "PUT", { content: "# User preferences\n\n- Always answer in bullet points\n", why: "changed my mind" });
await send(`dm:${bot("Scout").id}`, "what do you remember?");
await sleep(5000);
const reply = (await messages(`dm:${bot("Scout").id}`)).pop();
const text = reply.parts.filter((p) => p.kind === "text").map((p) => p.text).join(" ");
check("after an edit, a different agent sees the new text and not the old", /bullet points/.test(text) && !/under 100 words/.test(text));

console.log("\n# Agent factory and workflows");
const { draft } = await call("/api/factory", "POST", { description: "a legal reviewer called Lex who checks contracts for risky clauses and always asks first" });
const made = await call("/api/factory", "POST", { input: draft.input, memorySeed: draft.memorySeed });
check("an agent was created from a plain-language description", made.bot?.name === "Lex" && made.bot.approval === "ask");
const { workflow } = await call("/api/workflows", "POST", { name: "Competitor watch", instruction: "Monitor competitors of MeetUniversity and report what changed", conversationId: room("Market Intelligence"), schedule: "daily 09:00" });
check("a workflow was scheduled", workflow?.schedule.type === "daily" && Boolean(workflow.nextRunAt));
t0 = Date.now();
await call(`/api/workflows/${workflow.id}`, "POST");
await waitPlan(room("Market Intelligence"), undefined, 120, t0);
await sleep(1500);
let flows = await call("/api/workflows");
const run = flows.runs.find((r) => r.workflowId === workflow.id);
check("a manual run finished and is in the history with its report", run?.status === "done" && Boolean(run.artifactId));
await call(`/api/workflows/${workflow.id}`, "PATCH", { status: "paused" });
flows = await call("/api/workflows");
check("pause clears the next run; resume sets it again", !flows.workflows.find((w) => w.id === workflow.id).nextRunAt && Boolean((await call(`/api/workflows/${workflow.id}`, "PATCH", { status: "active" })).workflow.nextRunAt));

console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed"}`);
process.exit(failed ? 1 : 0);
