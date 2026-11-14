# Known limitations

Stated plainly, so nothing here surprises an evaluator.

## Not verified live by the build environment

The environment this was built in had no model keys and could not reach GitHub's API, DuckDuckGo, Gmail, Slack, Notion or MCP servers. So:

- Real Groq and Gemini calls were not run. The live-model path was exercised against a local OpenAI-compatible test server instead (plan, streaming, tool call, fallback).
- Live GitHub inspection, web search, Gmail, Slack, Notion and DeepWiki were not run. Their simulated paths and their logic (with stubbed responses for GitHub) were.

See [LIVE_VS_MOCKED.md](LIVE_VS_MOCKED.md). Run the "Test connection" buttons and the demos with your keys before relying on them.

## Design limits

- **One user, one machine.** No sign-in; the server listens on localhost only (as in the original).
- **Scheduled workflows run only while the app is running.** The scheduler is a timer inside the server, checked every 30 seconds. A run that was due while the app was off does not run retroactively; the next one is scheduled from the restart.
- **One plan per conversation at a time.** A new message during a run changes that plan rather than starting a second one.
- **A task that is already running does not see a new instruction.** It finishes; tasks not yet started and the final answer follow the new instruction. (A final answer in progress is restarted.)
- **Resume re-runs interrupted tasks from the start** of that task; finished tasks are kept. A task interrupted while waiting for approval asks again, because the old approval is expired on restart.
- **Rule planner is keyword-based.** It is the fallback when there is no model or the model's plan is unusable. It recognises kinds of work (data, repository, research, campaign, finance, leads, email, Slack, Notion, issue); anything else becomes a single task or a direct answer.
- **Mock mode cannot write.** Tasks that need original content say so. The mock reviewer checks structure only.
- **Spreadsheets: CSV only.** Save Excel sheets as CSV first. Files up to 5 MB.
- **Charts are bar and line SVGs.** No interactive charts.
- **GitHub write access is limited to opening issues.** No commits, branches or pull requests. Private repositories need a token.
- **Slack is post-only** (incoming webhook). **Notion is create-page-only**, with Markdown reduced to headings, bullets and paragraphs.
- **Gmail is send-only** over SMTP. No reading the inbox.
- **Web search without a key uses DuckDuckGo's HTML page**, which can rate-limit or change. Tavily is supported for reliability.
- **Controlled access pre-approvals** cover email recipient domains and GitHub repositories. Slack and Notion have no pre-approval rule, so under Controlled access they always ask (unless set to "never ask" at tool level).
- **Cost figures are estimates** from list prices; free-tier usage shows $0. Models whose price is unknown show no cost.
- **Collaboration budgets are fixed** per plan (4 delegations, 8 agent-to-agent messages, 14 tasks, depth 2).
- **Credentials saved in the app** are encrypted with a key stored in the data folder. Anyone with access to the machine and that folder can decrypt them; this protects against casual reading and accidental commits, not a compromised machine.
- **Composio, Browserbase and Jev** paths are unchanged from the original and were not verified with live services there either.

## Next.js advisory

`next dev` on the pinned version (16.4.0) prints a notice that the version is affected by a known security advisory and recommends upgrading. The original repository pins this version; it was left unchanged so the fork stays comparable. The app listens on localhost only. Upgrading Next.js is a sensible follow-up.
