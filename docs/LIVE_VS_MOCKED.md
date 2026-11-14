# Live vs mocked

Nothing in this project pretends to be live. An action that cannot reach a real service still goes through approval, is then written to `data/outbox/` instead of being sent, and is labelled **SIMULATED** in the agent's reply, the audit log and the tool catalog. The Integrations page shows the current state of each service.

## Integrations

| Integration | How it connects | Live when | Without credentials | Verified so far |
| --- | --- | --- | --- | --- |
| GitHub: inspect repository, read file | GitHub REST API | Always (public repositories, 60 requests/hour without a token) | Still live for reading | **Verified live, 14 Nov 2026**: real data returned for a public repository; a 404 for an unreadable one was reported honestly, not invented. A private repository needs `GITHUB_TOKEN`. |
| GitHub: open issue | GitHub REST API | `GITHUB_TOKEN` set | Simulated: saved to `data/outbox/*.json` | Simulated path verified end to end (approve and reject). Live path to be verified with a token. |
| Gmail: send email | SMTP (`smtp.gmail.com`) through nodemailer | `GMAIL_USER` + `GMAIL_APP_PASSWORD` set | Simulated: saved to `data/outbox/*.eml` | Simulated path verified end to end. Live path to be verified with an app password ("Test connection" signs in without sending). |
| Slack: post message | Incoming webhook | `SLACK_WEBHOOK_URL` set | Simulated: saved to `data/outbox` | Simulated path only. |
| Notion: create page | Notion API | `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` set | Simulated: saved to `data/outbox` | Simulated path only. |
| MCP servers | Remote MCP over HTTP (original app code) | A server is added (one click adds the free DeepWiki server) | Not available | Not run in the build environment (network). |
| Web search and page reading | DuckDuckGo HTML + direct fetch; Tavily if `TAVILY_API_KEY` is set | Always | n/a | Not run in the build environment (network). Run "Test connection". |
| Composio apps | Composio (original app code) | `COMPOSIO_API_KEY` set | Not available | Unchanged from the original; not verified. |
| Browserbase browser | Browserbase (original app code) | `BROWSERBASE_API_KEY` set | Not available | Unchanged from the original; not verified. |

> Before submitting, press **Test connection** on each integration you configured and update the last column with what you saw. The result of each test is also stored and shown on the Integrations page.

## Models

| Mode | When | What is real | What is not |
| --- | --- | --- | --- |
| Live | At least one provider key (or `OLLAMA_BASE_URL`) is set | Planning, agent replies, tool choice, consolidation, token counts | n/a |
| **Verified live** | Groq (`openai/gpt-oss-120b`) and Google Gemini, 14 Nov 2026 | A full 5-task plan: real planning, parallel tasks, `analyze_spreadsheet`, charts, a review that forced a revision, consolidation. See [TEST_EVIDENCE.md](TEST_EVIDENCE.md) section 5. | n/a |
| Mock | No provider key, or `OPENCREWBOT_MOCK=1` | The execution engine, parallelism, retries, timeouts, approvals, memory, workflows, and every tool call (spreadsheet analysis, charts, GitHub, search, outbox) | The wording. The mock model cannot write campaigns, strategies or judgments; it says so, and labels every reply and report "Mock model" / "MOCK MODE". The mock reviewer checks structure only and says so. |

Model fallback was verified against a local OpenAI-compatible test server (`tests/fake-llm.mjs`): a model-written plan, streamed replies, a model-initiated tool call, token accounting, and fallback from a failing model to a working one. Everything else in the live row above was verified against Groq and Gemini on a real machine.

## Data

| Data | Status |
| --- | --- |
| `samples/meetuniversity_sales_sample.csv` | **Synthetic.** 600 generated leads for demonstrating analysis. Not MeetUniversity's real data. Upload a real CSV on the Skills & tools page to analyse it instead. |
| `data/memory/PROJECT.md` starting text | Taken from the assignment brief; edit it on the Memory page. |
| Research results, repository findings, numbers in reports | Come from tool calls at run time. Agents are instructed not to state a number or source they did not get from a tool. |

## Fault injection (mock mode only)

`!fail-once:<word>`, `!fail-always:<word>` and `!slow:<word>` in an instruction make the task whose title contains `<word>` fail or stall. They exist to demonstrate retries, reassignment and timeouts on demand, and are ignored when a real model is in use.
