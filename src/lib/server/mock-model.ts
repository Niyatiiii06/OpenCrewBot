// A scripted stand-in for a real model, used when no provider key is set.
// It cannot think or write. What it does: read the request, call the REAL tools
// that fit it (spreadsheet analysis, GitHub inspection, web search, email with
// approval, memory, teammates), and stitch the tools' own output into a reply.
// Every reply says it came from the mock model. Nothing here is tied to one
// specific request: the choices come from the words in the task and the tools
// the agent has.
//
// Fault injection for tests and demos (mock mode only). Put one of these in an
// instruction to make the task whose title contains <word> misbehave:
//   !fail-once:<word>   fail the first attempt, succeed on the retry
//   !fail-always:<word> fail every attempt (shows reassignment and partial results)
//   !slow:<word>        take longer than the task timeout
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { listDataFiles } from "./data-analysis";

type Part = Record<string, unknown>;
type PromptMessage = { role: string; content: unknown };
type ToolCall = { name: string; input: Record<string, unknown> };
interface ToolResult {
  name: string;
  value: Record<string, unknown> | string | null;
}

const NOTE = "*(Mock model: no model key is set, so this wording is scripted. The tools really ran and their output is shown as it came back.)*";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p: { type?: string }) => p.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n");
}

function streamOf(parts: Part[], delayMs = 12): ReadableStream<Part> {
  return new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
        if (part.type === "text-delta") await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
}

function textParts(text: string): Part[] {
  // Stream in chunks of a few words so long tool output does not take minutes.
  const chunks = text.match(/(?:\S+\s*){1,6}/g) ?? [text];
  return [{ type: "text-start", id: "t" }, ...chunks.map((delta) => ({ type: "text-delta", id: "t", delta })), { type: "text-end", id: "t" }];
}

const section = (text: string, heading: string) => text.match(new RegExp(`## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ?? "";

function results(prompt: PromptMessage[], from: number): ToolResult[] {
  const out: ToolResult[] = [];
  for (const m of prompt.slice(from)) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ toolName?: string; output?: unknown }>) {
      const output = part.output as { value?: unknown } | undefined;
      const value = output && typeof output === "object" && "value" in output ? output.value : output;
      out.push({ name: part.toolName ?? "tool", value: (value ?? null) as ToolResult["value"] });
    }
  }
  return out;
}

function show(result: ToolResult): string {
  const v = result.value;
  if (v === null || v === undefined) return "(no output)";
  if (typeof v === "string") return v.slice(0, 2500);
  if (typeof v.markdown === "string") return v.markdown;
  if (v.saved === true && typeof v.scope === "string") return `Saved to memory (${v.scope}). It is in the Memory manager now, with who saved it and why.`;
  if (typeof v.answer === "string") return `**${String(v.from ?? "Teammate")} answered:** ${v.answer}`;
  if (typeof v.message === "string") return v.message;
  if (typeof v.error === "string") return `The tool reported an error: ${v.error}`;
  return `\`\`\`json\n${JSON.stringify(v, null, 2).slice(0, 1500)}\n\`\`\``;
}

/** The person's saved preferences, read from the system prompt the mock was given. */
function preferences(system: string): string[] {
  const block = system.match(/### The person's preferences[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/)?.[1] ?? "";
  return block.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.replace(/_\(.*?\)_/g, "").trim()).slice(0, 6);
}

function ownMemory(system: string): string[] {
  const block = system.match(/## Your memory \(MEMORY\.md\)[\s\S]*?\n\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
  return block.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.replace(/_\(.*?\)_/g, "").trim()).slice(0, 8);
}

const failures = new Map<string, number>();

/** Apply `!fail-once:word`, `!fail-always:word` and `!slow:word` to the matching task. */
async function injectFaults(full: string, title: string, botName: string) {
  for (const [, kind, word] of full.matchAll(/!(fail-once|fail-always|slow):([\w-]+)/g)) {
    if (!`${title} ${botName}`.toLowerCase().includes(word.toLowerCase())) continue;
    const key = `${full.match(/^\[[^\]]+\]/)?.[0] ?? ""}|${title}|${kind}`;
    const seen = failures.get(key) ?? 0;
    failures.set(key, seen + 1);
    if (kind === "slow") await new Promise((r) => setTimeout(r, Number(process.env.OPENCREWBOT_TASK_TIMEOUT_MS || 240_000) + 5_000));
    if (kind === "fail-always" || (kind === "fail-once" && seen === 0)) throw new Error(`Injected failure (${kind}) for "${title}": the provider returned HTTP 503.`);
  }
}

/** The tool calls that fit this request, in order. Later steps can read earlier results. */
function script(focus: string, full: string, tools: Set<string>, isTask: boolean): Array<(done: ToolResult[]) => ToolCall | null> {
  const steps: Array<(done: ToolResult[]) => ToolCall | null> = [];
  const has = (name: string) => tools.has(name);
  const repo = full.match(/github\.com\/([\w.-]+\/[\w.-]+)/i)?.[1] ?? full.match(/\b([A-Za-z0-9][\w-]+\/[A-Za-z0-9][\w.-]+)\b(?=.*\b(repo|repository)\b)/i)?.[1];
  const email = full.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const asked = (full.match(/The person asked: "([\s\S]*?)"\n/)?.[1] ?? section(full, "The person's instruction") ?? focus).replace(/![\w-]+:[\w-]+/g, "").trim();
  const earlier = (done: ToolResult[]) => [section(full, "Results from earlier tasks"), ...done.map(show)].filter(Boolean).join("\n\n").replace(/<\/?result[^>]*>/g, "").split(NOTE).join("").replace(/^VERIFIED[^\n]*\n+The mock reviewer[^\n]*\n*/gm, "").trim();

  if (!isTask) {
    const remember = focus.match(/remember (?:that )?(.+)/i);
    if (remember && has("memory_add")) {
      const scope = /\b(i|my|me)\b/i.test(remember[1]) ? "user" : /\b(we|our|company|project)\b/i.test(remember[1]) ? "project" : "self";
      steps.push(() => ({ name: "memory_add", input: { note: remember[1].trim(), scope, why: "you asked me to remember it" } }));
    }
    if (/\bask me\b/i.test(focus) && has("ask_user")) {
      steps.push(() => ({ name: "ask_user", input: { question: "Do you want short answers or detailed ones?", options: [{ label: "Short" }, { label: "Detailed", description: "With sources and caveats" }] } }));
    }
    const url = focus.match(/\bopen (https?:\/\/\S+)/i);
    if (url && has("browser_goto")) steps.push(() => ({ name: "browser_goto", input: { url: url[1] } }));
    const mate = focus.match(/\b(ask|verify with|challenge|delegate to)\s+@([\w-]+)[\s:,]*(.*)/i);
    if (mate) {
      const [, verb, to, rest] = mate;
      const body = rest.trim() || "Please help with the request above.";
      if (/delegate/i.test(verb) && has("delegate_task")) steps.push(() => ({ name: "delegate_task", input: { to, task: body.padEnd(10, "."), reason: "asked by the person" } }));
      else if (/verify/i.test(verb) && has("request_verification")) steps.push(() => ({ name: "request_verification", input: { to, content: body.padEnd(10, ".") } }));
      else if (/challenge/i.test(verb) && has("challenge_conclusion")) steps.push(() => ({ name: "challenge_conclusion", input: { to, conclusion: body.padEnd(5, "."), objection: "Is there evidence for this?" } }));
      else if (has("ask_teammate")) steps.push(() => ({ name: "ask_teammate", input: { to, question: body.padEnd(5, ".") } }));
      return steps;
    }
  }

  if (has("analyze_spreadsheet") && /spreadsheet|\.csv|analy[sz]e|sales data|funnel|pipeline|dataset/i.test(focus)) {
    const files = listDataFiles().map((f) => f.name);
    const file = files.find((f) => full.toLowerCase().includes(f.toLowerCase())) ?? files[0];
    if (file) steps.push(() => ({ name: "analyze_spreadsheet", input: { file, charts: true } }));
  }
  if (has("github_inspect_repo") && repo && /repo|github|inspect|code|review/i.test(focus) && !/open the github issue/i.test(focus)) {
    steps.push(() => ({ name: "github_inspect_repo", input: { repo } }));
  }
  if (has("web_search") && /\b(research|competitors?|market|search|look up|look into|find out|trends?|intelligence|monitor)\b/i.test(focus)) {
    const query = `${asked.split(/\s+/).slice(0, 14).join(" ")}${/competitor/i.test(focus) ? " competitors" : ""}`.replace(/["“”]/g, "");
    steps.push(() => ({ name: "web_search", input: { query, maxResults: 5 } }));
    if (has("read_page")) {
      steps.push((done) => {
        const hits = (done.find((r) => r.name === "web_search")?.value as { results?: { url?: string }[] } | null)?.results ?? [];
        return hits[0]?.url ? { name: "read_page", input: { url: hits[0].url, urls: [hits[0].url] } } : null;
      });
    }
  }
  if (has("github_create_issue") && repo && /(open|create|file|raise)[\s\w]*issue/i.test(focus)) {
    steps.push((done) => {
      const body = earlier(done) || "No findings were available.";
      const first = body.split("\n").find((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l) && l.length > 20)?.replace(/^[\s\-*\d.]+/, "").replace(/\*\*/g, "") ?? "Review findings";
      return { name: "github_create_issue", input: { repo, title: `Review: ${first}`.slice(0, 110), body: `Raised from an automated repository review.\n\n${body.slice(0, 1800)}` } };
    });
  }
  if (has("send_email") && email && /\bemail\b|send_email/i.test(focus)) {
    steps.push((done) => ({ name: "send_email", input: { to: email, subject: asked.split(/\s+/).slice(0, 9).join(" "), body: `Hello,\n\nHere is the summary you asked for.\n\n${(earlier(done) || asked).slice(0, 1500)}\n\n(Sent by OpenCrewBot in mock mode.)` } }));
  }
  if (has("slack_post") && /\bslack\b/i.test(focus)) steps.push((done) => ({ name: "slack_post", input: { text: `Update: ${asked.slice(0, 120)}\n${earlier(done).slice(0, 500)}` } }));
  if (has("notion_create_page") && /\bnotion\b/i.test(focus)) steps.push((done) => ({ name: "notion_create_page", input: { title: asked.slice(0, 80), content: earlier(done).slice(0, 3000) || asked } }));
  return steps;
}

function consolidated(full: string, prefs: string[]): string {
  const blocks = [...full.matchAll(/<result task="([^"]+)" title="([^"]*)" agent="([^"]*)" status="([^"]+)">\n([\s\S]*?)\n<\/result>/g)].map(([, ref, title, agent, status, body]) => ({ ref, title, agent, status, body: body.replace(NOTE, "").trim() }));
  const done = blocks.filter((b) => b.status === "done");
  const missing = blocks.filter((b) => b.status !== "done");
  const flagged = done.filter((b) => /NOT EXECUTED|SIMULATED/.test(b.body));
  const amendments = section(full, "New instructions since the plan started");
  return [
    `# ${full.match(/plan "([^"]+)"/)?.[1] ?? "Result"}`,
    NOTE,
    `## Summary\n${done.map((b) => `- **${b.ref} ${b.title}** (${b.agent}): done`).join("\n")}${missing.map((b) => `\n- **${b.ref} ${b.title}** (${b.agent}): ${b.status}`).join("")}`,
    prefs.length ? `**Your saved preferences that apply:**\n${prefs.join("\n")}` : "",
    amendments ? `**New instructions taken into account:**\n${amendments}` : "",
    ...done.map((b) => `## ${b.ref} · ${b.title} (${b.agent})\n\n${b.body}`),
    missing.length || flagged.length
      ? `## Not completed\n${[...missing.map((b) => `- ${b.ref} ${b.title}: ${b.status}. ${b.body.split("\n")[0]}`), ...flagged.map((b) => `- ${b.ref} ${b.title}: ${/NOT EXECUTED/.test(b.body) ? "an action was rejected or blocked and was not executed" : "an action was simulated, not sent to a real service"}.`)].join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
}

export function createMockModel(botName: string) {
  return new MastraLanguageModelV2Mock({
    provider: "mock",
    modelId: "mock-model",
    // The mock's stream-part type isn't exported, so the scripted parts are cast.
    doStream: (async (options: { prompt: unknown; tools?: Array<{ name: string }> }) => {
      const prompt = options.prompt as PromptMessage[];
      const tools = new Set((options.tools ?? []).map((t) => t.name));
      const system = prompt.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
      let lastUser = prompt.length - 1;
      while (lastUser > 0 && prompt[lastUser].role !== "user") lastUser--;
      const full = textOf(prompt[lastUser]?.content);
      const done = results(prompt, lastUser + 1);
      const start = [{ type: "stream-start", warnings: [] }];
      const usage = (out: string) => {
        const inputTokens = Math.round(prompt.reduce((n, m) => n + textOf(m.content).length, 0) / 4);
        const outputTokens = Math.round(out.length / 4);
        return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
      };
      const say = (text: string) => ({ stream: streamOf([...start, ...textParts(text), { type: "finish", finishReason: "stop", usage: usage(text) }]) });

      const isTask = /^\[Task /.test(full);
      const isFinal = /^\[Final consolidation/.test(full);
      const isTeammate = /^\[(Question|Verification request|Challenge|Work handed)/.test(full);
      const prefs = preferences(system);

      if (isFinal) {
        await injectFaults(full, "Consolidate the final answer", botName);
        return say(consolidated(full, prefs));
      }

      // What the request is about: the task brief, a teammate's message, or the person's latest line.
      const taskTitle = full.match(/## Your task: ([^\n]+)/)?.[1] ?? "";
      const lines = full.split("\n").filter(Boolean);
      const personLine = lines.filter((l) => l.startsWith("Person: ")).pop();
      const focus = isTask ? `${taskTitle}\n${(section(full, "Your task").match(/Your part: ([\s\S]*)/)?.[1] ?? section(full, "Your task"))}` : isTeammate ? full.split("\n\n")[1] ?? full : personLine ? personLine.slice("Person: ".length) : (lines.pop() ?? "");
      if (isTask && done.length === 0) await injectFaults(full, taskTitle, botName);

      const steps = script(focus, full, tools, isTask);
      let used = 0;
      for (const step of steps) {
        const call = step(done);
        if (!call) continue;
        if (used < done.length) {
          used++;
          continue;
        }
        return {
          stream: streamOf([
            ...start,
            { type: "tool-call", toolCallId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, toolName: call.name, input: JSON.stringify(call.input) },
            { type: "finish", finishReason: "tool-calls", usage: usage("") },
          ]),
        };
      }

      const shown = done.map(show).join("\n\n");
      if (isTask) {
        if (/^Verify the work|review/i.test(taskTitle) && !done.length) {
          const inputs = section(full, "Results from earlier tasks");
          const bad = [...inputs.matchAll(/<result task="([^"]+)"[^>]*status="(?!done)([^"]+)"/g)].map((m) => `${m[1]} is ${m[2]}`);
          const links = (inputs.match(/https?:\/\//g) ?? []).length;
          return say(
            bad.length
              ? `NEEDS CHANGES\n\n${bad.map((b, i) => `${i + 1}. ${b}.`).join("\n")}\n\n${NOTE}`
              : `VERIFIED (structure only)\n\nThe mock reviewer can only check structure: every input task finished, and the inputs contain ${links} source link${links === 1 ? "" : "s"}. A real model checks the claims themselves.\n\n${NOTE}`,
          );
        }
        if (done.length) return say(`${shown}\n\n${prefs.length ? `**Your saved preferences that apply:**\n${prefs.join("\n")}\n\n` : ""}${NOTE}`);
        const inputs = [...full.matchAll(/<result task="([^"]+)" title="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
        return say(
          `**${taskTitle}: not written in mock mode.** This task needs a model to write original content, and no model key is set. Add a free Groq or Gemini key on the Models page and run it again.\n\n` +
            `${inputs.length ? `Inputs this task received and would use: ${inputs.join("; ")}.\n\n` : ""}${prefs.length ? `**Your saved preferences that would apply:**\n${prefs.join("\n")}\n\n` : ""}${NOTE}`,
        );
      }
      if (done.length) return say(`${shown}\n\n${NOTE}`);

      if (isTeammate) return say(`${/^\[Verification/.test(full) ? "NOT VERIFIED\n\nThe mock model cannot check claims. " : /^\[Challenge/.test(full) ? "REVISED\n\nThe mock model cannot weigh evidence. " : ""}I'm **${botName}** on the mock model and received your message: "${focus.slice(0, 200)}". A real model would answer it here.\n\n${NOTE}`);
      if (/what do you (remember|know)|my preferences|your memory/i.test(focus)) {
        const mine = ownMemory(system);
        return say(`Here is what I can see in memory right now (read from the files on this turn):\n\n**Your preferences (USER.md)**\n${prefs.join("\n") || "- nothing saved yet"}\n\n**My own notes (MEMORY.md)**\n${mine.join("\n") || "- nothing saved yet"}\n\n${NOTE}`);
      }
      return say(
        `Hi, I'm **${botName}**, running on the *mock model* because no model key is set.\n\nYou said: "${focus.slice(0, 200)}"\n\n` +
          `${prefs.length ? `Your saved preferences I can see:\n${prefs.join("\n")}\n\n` : ""}` +
          "Try `remember that I prefer short answers`, `what do you remember?`, `search for study abroad trends`, or give the Chief of Staff a full instruction in a room to see planning, parallel tasks and approvals.\n\n" +
          "Add a free Groq or Gemini key on the Models page for real answers.",
      );
    }) as never,
  });
}
