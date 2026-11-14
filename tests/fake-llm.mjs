// A tiny OpenAI-compatible server for testing the live-model path without a key.
// Point OpenCrewBot at it with OLLAMA_BASE_URL=http://127.0.0.1:11999.
// - "broken" always answers HTTP 503, to exercise model fallback.
// - "planner" answers planning prompts with a JSON plan and other prompts with text.
// It calls a tool when the request offers analyze_spreadsheet and mentions a spreadsheet.
import http from "node:http";

const PORT = Number(process.env.FAKE_LLM_PORT || 11999);
const log = [];

function sse(res, chunks, usage) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const base = { id: "fake", object: "chat.completion.chunk", created: 1, model: "fake" };
  for (const delta of chunks) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  const finish = chunks.some((c) => c.tool_calls) ? "tool_calls" : "stop";
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

http
  .createServer((req, res) => {
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "broken" }, { name: "planner" }] }));
    if (req.url === "/log") return res.end(JSON.stringify(log));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      log.push({ model: body.model, stream: Boolean(body.stream), tools: (body.tools ?? []).length });
      if (body.model === "broken") {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "The model is overloaded (fake 503)." } }));
      }
      const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(" "));
      const system = body.messages.filter((m) => m.role === "system").map(text).join("\n");
      const last = body.messages[body.messages.length - 1];
      const user = [...body.messages].reverse().find((m) => m.role === "user");
      const usage = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 };
      let reply;
      if (/Return ONLY a JSON/.test(system) && /turn one instruction into a task plan/.test(system)) {
        reply = JSON.stringify({
          direct: false,
          goal: "Analyse sales data and summarise it",
          tasks: [
            { ref: "T1", title: "Analyse the spreadsheet", description: "Analyse the sales spreadsheet meetuniversity_sales_sample.csv with analyze_spreadsheet and report the funnel.", agent: "dex", dependsOn: [], skills: ["data-analysis"], capability: "spreadsheet analysis", kind: "work", needsApproval: false },
            { ref: "T2", title: "Recommend actions", description: "Turn the analysis into three recommendations.", agent: "atlas", dependsOn: ["T1"], skills: [], capability: "strategy", kind: "work", needsApproval: false },
          ],
          newAgents: [],
        });
      } else if (last.role === "tool") {
        reply = `Fake model: the tool returned ${String(text(last) || JSON.stringify(last.content)).slice(0, 200)}`;
      } else if ((body.tools ?? []).some((t) => t.function?.name === "analyze_spreadsheet") && /spreadsheet/i.test(text(user ?? {}))) {
        const call = { index: 0, id: "call_1", type: "function", function: { name: "analyze_spreadsheet", arguments: JSON.stringify({ file: "meetuniversity_sales_sample.csv", charts: false }) } };
        if (body.stream) return sse(res, [{ role: "assistant", tool_calls: [call] }], usage);
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage }));
      } else {
        reply = `Fake model reply to: ${text(user ?? {}).slice(0, 120)}`;
      }
      if (body.stream) return sse(res, [{ role: "assistant", content: reply }], usage);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "fake", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake LLM on ${PORT}`));
