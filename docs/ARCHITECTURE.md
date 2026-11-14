# Architecture

OpenCrewBot 2.0 keeps the original app's shape: one Next.js process that serves the interface and the API, Mastra as the agent harness, SQLite for app data, Markdown files for memory, and one server-sent-event stream that keeps the browser live. Everything new sits beside the original code and reuses its paths (a task is an ordinary agent turn in an ordinary room).

```
Browser (React 19)
  Sidebar · Chat · Inspector            ← original
  Tasks · Approvals · Memory · Skills & tools · Integrations · Models · Workflows · History   ← 2.0
        │  fetch /api/*                         ▲  one SSE stream (/api/events)
        ▼                                       │
Next.js route handlers (src/app/api)  ──────────┘
        │
        ▼
src/lib/server
  service.ts      create/update agents and rooms, send a message, boot and recovery
  rooms.ts        who answers in a room (mention, Jev, lead, everyone, or the Chief of Staff)
  planner.ts      instruction → tasks (model plan, or rule planner as fallback)
  engine.ts       runs a plan: parallel tasks, retries, timeouts, cancel, amend, resume
  collab.ts       ask / verify / challenge / delegate / share between agents, with loop guards
  runtime.ts      one Mastra AgentController per agent, one session per conversation; model fallback
  tools.ts        original tools (Tavily, code mode, browser) + native-tools.ts (2.0 tools)
  permissions.ts  the approval gate, the three levels, the audit log
  integrations.ts GitHub, Gmail, Slack, Notion, keyless web search
  memory-files.ts Markdown memory scopes with provenance
  skills.ts       skill library loaded from skills/ and data/skills/
  providers.ts    model providers, routing tiers, fallback chain
  workflows.ts    schedules and run history
  factory.ts      plain-language description → agent
  db.ts           SQLite tables (JSON rows)
        │
        ▼
data/  opencrewbot.db · mastra.db · workspaces/<agent>/MEMORY.md · memory/*.md · artifacts/ · outbox/ · uploads/ · skills/
```

## How one instruction becomes finished work

1. **Message arrives** (`service.sendMessage`). In a room whose responder is "Chief of Staff", or in a direct message with the Chief, it goes to the engine. If a plan is already running in that conversation the message is treated as a new instruction for that plan (step 7).
2. **Planning** (`planner.makePlan`). The Chief's model gets the instruction, the team roster with each agent's tools and skills, the skill library, the data files and shared memory, and returns JSON: tasks with an agent, dependencies, skills and whether the task needs approval. The JSON is validated with zod; unknown agents are re-matched, unknown dependencies dropped, cycles broken. If there is no model, or its answer cannot be used, the **rule planner** matches the request to capabilities (data, repository, research, campaign, email…) and builds the plan from those. A greeting or short question returns "direct" and the Chief simply answers.
3. **Staffing** (`engine.startPlan`). If the assigned agent lacks the tool a task needs, the engine first looks for an agent in the room with it, then anywhere in the workspace, and finally asks the agent factory to create one. This is recorded in the plan log and the audit log.
4. **Execution loop** (`engine.drive`). A task is ready when its dependencies have ended. Up to three ready tasks run at once (`OPENCREWBOT_MAX_PARALLEL`), one per agent. Each task is a normal agent turn in the room (`runtime.runTurn`), so its tool steps, approvals and reply appear in chat. The task prompt holds the instruction, any newer instructions, the results of the tasks it depends on, and the skills loaded for it.
5. **Failure handling.** A task that errors or times out (default 240 s; the clock pauses while it waits for your approval) is retried, on a different model if a real provider failed. After two attempts it is reassigned once to another agent that has the needed tool. If it still fails it is marked failed. Tasks that depended only on failed work are skipped; actions on the outside world are skipped if any input failed; other work continues with the inputs it has. Consolidation always runs and lists what was not completed. If consolidation itself fails, the engine stitches the task results into a report so you still get the work.
6. **Review and rework.** A review task that answers NEEDS CHANGES adds one revision task for the author; later actions wait for it.
7. **Interruption.** A new message during a run is added to the plan's instructions. The Chief (or the rule planner) decides which unfinished tasks to cancel and which to add. Tasks not yet started see the new instruction; a final answer already being written is stopped and rewritten. "stop" or "cancel" cancels the plan.
8. **Finish.** The consolidated answer is saved as a Markdown report in `data/artifacts`, linked in chat, and one line is appended to `HISTORY.md`.
9. **Restart.** Every change to a plan is saved to SQLite. At startup, plans that were running are marked interrupted, their pending approvals are expired (so nothing can be approved late), and a notice is posted. **Resume** keeps finished tasks and runs the rest.

## Approval enforcement

There is one checkpoint, `permissions.gate()`, in front of every native tool that acts outside the app (email, Slack, Notion, GitHub issue). The tool body looks like this:

```ts
const cleared = await gate(bot, tool, args, turn);
if (!cleared.allowed) return { executed: false, ... };   // the send function is never called
const result = await run();                               // only reached after approval
```

`gate()` decides from the agent's level, its tool-level overrides and its Controlled-access limits. If it must ask, it stores an approval with a preview of the exact action, shows the buttons in chat and in the Approvals page, and waits. Reject, cancel, stop, timeout and restart all resolve the wait as "not allowed". Browser, MCP and Composio tools use Mastra's own approval mechanism (from the original app); those requests are recorded in the same approval list and audit log.

| Level | Read tools | Local changes (memory, files) | External actions |
| --- | --- | --- | --- |
| Ask first | run | run | always ask |
| Controlled access | run | run | run only if pre-approved (email domain list, repository list) and under the per-run limit; otherwise ask |
| Full access | run | run | run without asking |

A tool-level setting (always ask / never ask / blocked) overrides the level for that tool.

## Memory

| File | Scope | Who reads it |
| --- | --- | --- |
| `data/workspaces/<agent>/MEMORY.md` | one agent | that agent |
| `data/memory/rooms/<room>.md` | one room | agents working in that room |
| `data/memory/PROJECT.md` | the business | every agent |
| `data/memory/USER.md` | your preferences | every agent |
| `data/memory/DECISIONS.md` | settled decisions | every agent |
| `data/memory/HISTORY.md` | one line per finished plan | every agent (latest lines) |

The system prompt is rebuilt on every model call and reads these files from disk each time. That is why memory survives a restart and why an edit applies to the very next reply. Every write (by an agent, by you, by the system) adds a row to `memory_log` with what, when, who, why and source; the Memory page shows it. Likely secrets are redacted before anything is written.

## Skills

A skill is a folder with a `SKILL.md`: front matter (`name`, `description`, `triggers`, `tools`, `output`) and Markdown instructions. Built-in skills live in `skills/`; skills you add in the app live in `data/skills/` and can override a built-in one. Skills are read from disk when needed, so a new skill is usable without a restart. Three ways a skill is loaded: pinned on the agent, chosen for a task by trigger words, or pulled by the agent with the `use_skill` tool.

## Models

`providers.ts` lists seven providers. A model id is `<provider>/<model>`. For each turn the runtime builds a chain: the agent's model (or, for Auto agents, the model for the task's tier: fast, balanced or strong), the agent's own fallbacks, the same tier on every other configured provider, then other models of the same providers. If a model call fails before producing anything, the same turn is retried on the next model, the message is marked "fell back from …", and the event goes to the audit log. Failed models go to the back of the line for two minutes. Token counts come from the provider; cost uses list prices per million tokens.

## Data model (SQLite, `data/opencrewbot.db`)

`bots`, `rooms`, `messages`, `settings` (original) and `plans` (tasks embedded), `approvals`, `audit`, `usage`, `workflows`, `workflow_runs`, `memory_log`, `artifacts` (2.0). Rows are JSON, which keeps migrations simple: older rows get defaults when read (`normalizeBot`).

## Security notes

- The API has no sign-in and listens on 127.0.0.1 only; `src/proxy.ts` (original) refuses cross-site and non-localhost requests.
- Credentials saved in the app are encrypted with AES-256-GCM; the key is in `data/.secret-key` or `OPENCREWBOT_SECRET_KEY`. They are never sent to the browser.
- Web pages, files and other agents' messages are treated as information, not instructions (stated in every system prompt). `read_page` refuses private network addresses.
- Data tools can only open files in `data/uploads` and `samples/`.
- Saved reports and charts are served with a restrictive Content-Security-Policy.
