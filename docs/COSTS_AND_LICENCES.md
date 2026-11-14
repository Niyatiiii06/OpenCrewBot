# Costs, dependencies and licences

## Running cost: zero is possible

| Item | Free option used here | Paid alternative (optional) |
| --- | --- | --- |
| Models | Groq free tier, Google Gemini free tier, OpenRouter `:free` models, or Ollama on your own machine | Nebius, OpenAI, Anthropic |
| Web search | DuckDuckGo HTML (no key) | Tavily |
| GitHub | REST API without a token for public reads; a free personal access token to open issues | n/a |
| Email | Your own Gmail account over SMTP with an app password | n/a |
| Slack | Free incoming webhook | n/a |
| Notion | Free internal integration | n/a |
| MCP | DeepWiki's free public server, or any server you add | n/a |
| Database | SQLite file on disk (libSQL) | n/a |
| Hosting | Runs on your machine | n/a |

Free tiers have rate limits. When a provider rejects a call, the turn falls back to the next model; with two free keys (Groq and Gemini) a rate limit on one does not stop the work. The Models page shows tokens and cost by model, agent and day. Cost is calculated from each provider's list price per million tokens; free-tier and local models count as $0.

Indicative token use, measured against the local test server (a plan of 2 work tasks plus consolidation): 5 model calls, about 5,400 input and 720 output tokens. Real plans with research and long reports will use more.

## Dependencies added in 2.0

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| nodemailer | 10.5.0 | MIT-0 | Send email over SMTP |
| @types/nodemailer (dev) | 8.0.2 | MIT | Types |
| vitest (dev) | 5.1.0 | MIT | Unit tests |

Everything else in 2.0 (planner, engine, CSV parsing, statistics, SVG charts, schedules, encryption, GitHub/Slack/Notion calls) uses Node's standard library and `fetch`.

## Dependencies inherited from the original

| Package | Version | Licence |
| --- | --- | --- |
| next | 16.4.0 | MIT |
| react, react-dom | 19.3.0 | MIT |
| @mastra/core, @mastra/memory, @mastra/libsql, @mastra/mcp, @mastra/tavily, @mastra/quickjs, @mastra/agent-browser | 1.76.0 and matching | Apache-2.0 |
| @libsql/client | 0.18.0 | MIT |
| @composio/core, @composio/mastra | 0.23.0, 0.10.5 | ISC |
| @tavily/core | 0.7.14 | MIT |
| zod | 4.6.7 | MIT |
| react-markdown, remark-gfm | 10.1.0, 4.0.1 | MIT |
| lucide-react | 1.55.0 | ISC |
| clsx, tailwind-merge, tailwindcss | 2.1.1, 3.7.0, 4.3.3 | MIT |
| typescript (dev) | 5.9.3 | Apache-2.0 |
| eslint, eslint-config-next (dev) | 9.39.5, 16.4.0 | MIT |

All are permissive licences compatible with this project's MIT licence. Licences were read from each package's `package.json` in `node_modules`.

## This project

MIT, unchanged from the original: see [LICENSE](../LICENSE). The original copyright notice is retained.

## External services' terms

Using Groq, Gemini, OpenRouter, GitHub, Gmail, Slack, Notion, DuckDuckGo or DeepWiki is subject to each service's own terms and rate limits. The DuckDuckGo HTML endpoint is not an official API; for heavy or commercial use, set `TAVILY_API_KEY` or add a search MCP server.
