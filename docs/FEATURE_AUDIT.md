# Feature audit: original OpenCrewBot vs 2.0

Audited from the source of [Studio1-OSS/OpenCrewBot](https://github.com/Studio1-OSS/OpenCrewBot) at commit `4784e3a` ("Add MIT license"), by reading the code and running it in mock mode.

## What the original had

| Area | Original | State |
| --- | --- | --- |
| Agents | Bots with name, role, instructions, colour, one model, five tool switches | Implemented |
| Chat | Direct messages, streaming replies, tool steps, cost per reply | Implemented |
| Rooms | @mentions, `@everyone`, Jev auto-routing, lead fallback, hand-off by @mention (two hops) | Implemented; responders run one after another |
| Memory | One `MEMORY.md` per bot, editable, secret redaction | Implemented; no shared, room or project memory, no provenance |
| Approvals | "Allow once / Deny" cards for browser, MCP and Composio actions; two levels (ask, full) | Implemented; no approval list, no audit log, no previews beyond the tool name |
| Tools | Tavily search/extract/crawl, QuickJS code mode, Browserbase browser, ask-user card | Implemented; search needs a paid-tier key |
| Integrations | Composio apps and remote MCP servers | Implemented; Composio needs a key; its README says these paths were not verified against live services |
| Models | Nebius Token Factory only, hard-coded (`nebius/<model>`) | Single provider, no fallback |
| Mock mode | Scripted model for clicking through the UI | Implemented; four canned behaviours |
| Restart | Streaming messages marked "interrupted" | Implemented; nothing resumes |
| Planning, tasks, parallel work | None | Missing |
| Agent creation from a description | None (form only) | Missing |
| Skills | None | Missing |
| Scheduled work | None ("scheduled routines" listed as future work) | Missing |
| Cost dashboard | Per reply only | Partial |

## What 2.0 adds or changes

| Requirement | 2.0 | Files |
| --- | --- | --- |
| A. Chief of Staff: decompose, select agents, dependencies, parallel, monitor, handle failures, consolidate | Model planner with validated JSON; rule planner as fallback; staffing from the room, the workspace or the agent factory; consolidated report | `planner.ts`, `engine.ts` |
| B. Agent factory from natural language | Draft (model or rules) → review in the form → create; sets role, persona, model mode, tools, skills, starting memory, permissions, output format; the Chief can also create agents during planning | `factory.ts`, `BotForms.tsx`, `/api/factory` |
| C. Rooms: delegate, ask, share, challenge, verify; resume; parallel and sequential; loop prevention | Five collaboration tools; delegation becomes a tracked task; guards: no self-talk, depth 2, wait-for cycle check, 4 contacts per turn, per-plan budget (4 delegations, 8 messages, 14 tasks), 150 s answer limit | `collab.ts`, `native-tools.ts`, `rooms.ts` |
| D. Execution engine | Plans with embedded tasks in SQLite; id, agent, dependencies, status, start/end, attempts, output, error, approval state; retry, reassign, timeout, cancel plan or task, retry task, resume after restart, event log | `engine.ts`, `PlanView.tsx`, Tasks and History pages |
| E. Memory | Six scopes in Markdown; editor; provenance log (what, when, who, why, source); re-read on every model call | `memory-files.ts`, Memory page |
| F. Skills and tools | 12 built-in skills, custom skills saved from the UI and loaded without a restart, 3 loading paths, tool catalog with risk and live status, CSV upload | `skills/`, `skills.ts`, Skills & tools page |
| G. Permissions and safety | Three levels, Controlled limits (email domains, repositories, actions per run), tool-level overrides, preview, approve/reject in chat and in the approval centre, audit log, cancellation releases approvals, expired on restart, AES-256-GCM credential store | `permissions.ts`, `secrets.ts`, Approvals page |
| H. Integrations (≥3) | GitHub (REST), Gmail (SMTP), Slack (webhook), Notion (API), MCP (original, plus one-click DeepWiki), keyless web search; each labelled live or simulated | `integrations.ts`, Integrations page |
| I. Scheduled workflows | Interval, daily, weekly, manual; run now; pause/resume; run history with report; failure count and notice | `workflows.ts`, Workflows page |
| J. Models | Groq, Gemini, OpenRouter, Nebius, OpenAI, Anthropic, Ollama (local); per-agent model and fallbacks; Auto routing by task tier; turn-level fallback; token and cost tables | `providers.ts`, `runtime.ts`, `llm.ts`, Models page |
| Mock mode | The mock model now drives the real engine and real tools, and labels every reply; fault injection for failure demos | `mock-model.ts` |

## Minimums

| Required | Delivered |
| --- | --- |
| 8 configurable agents | 9 seeded (Chief, Scout, Quill, Atlas, Dex, Forge, Echo, Vera, Sage); unlimited more through the form or the factory |
| 4 rooms | 6 seeded (Command Room, Market Intelligence, Campaign Studio, Sales and Data, Engineering, Studio) |
| 8 skills | 12 built-in |
| 3 working integrations | GitHub, Gmail, Slack, Notion, MCP, web search (see [LIVE_VS_MOCKED.md](LIVE_VS_MOCKED.md) for what was verified) |
| 3 permission levels | Ask first, Controlled access, Full access |
| Working mock mode | Yes; 29 end-to-end checks run in it |

## Original files changed

`runtime.ts` (model chain and fallback, turn context, approvals and usage recording, stop one turn), `service.ts` (seed, boot recovery, Chief routing), `rooms.ts` (Chief responder, interruption), `tools.ts` (merges the new tools), `prompt.ts` (role, shared memory, skills, output format), `mock-model.ts` (rewritten), `models.ts`, `config.ts`, `db.ts`, `memory-files.ts`, `types.ts` (extended), `OpenCrewBotApp.tsx`, `Sidebar.tsx`, `Message.tsx`, `BotForms.tsx`, `Inspector.tsx`, `SettingsPanel.tsx`, `ModelPicker.tsx`, `store.ts`, `api.ts`, `next.config.ts`, `.env.example`, `package.json`.

New: `engine.ts`, `planner.ts`, `collab.ts`, `factory.ts`, `workflows.ts`, `permissions.ts`, `integrations.ts`, `native-tools.ts`, `providers.ts`, `llm.ts`, `skills.ts`, `artifacts.ts`, `data-analysis.ts`, `secrets.ts`, `turns.ts`, `instrumentation.ts`, `Workspace.tsx`, `PlanView.tsx`, `Markdown.tsx`, 15 API route files, `skills/` (12), `samples/`, `tests/`, `docs/`.
