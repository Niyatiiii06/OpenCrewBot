# Test evidence

Three layers: unit tests, end-to-end checks against the running app, and recorded runs of failure recovery and approval enforcement. Raw outputs are in [docs/evidence](evidence).

What these runs do **not** cover is listed at the end.

## 1. Unit tests: 22 passed

`pnpm test` · output: [evidence/unit-tests-output.txt](evidence/unit-tests-output.txt)

| Area | What is tested |
| --- | --- |
| Permission levels | Ask first always asks; Controlled runs only pre-approved recipients and only within the per-run limit; Full access runs; a tool-level block wins over Full access; read tools never ask |
| Approval enforcement | A rejected action is never executed (the send function is not called and the outbox stays empty); a blocked tool is refused and logged; stopping a run cancels a waiting approval |
| Rule planner | Mixed request → parallel gathering, dependent writing, review, then a gated action; short question → direct answer; missing capability → asks for a new agent |
| Data analysis | Quoted CSV parsing; funnel and totals of the sample file; SVG chart; refuses paths outside the data folders |
| Memory | Provenance line is written; an edit replaces what agents read next; secrets are redacted |
| Skills | At least eight; selection by task wording; a new skill is usable without a restart |
| Workflow schedules | Plain-language parsing; next-run calculation |
| GitHub integration | Repository name parsing; structural findings from stubbed API responses |

## 2. End-to-end checks in mock mode: 29 passed

`node tests/e2e-mock.mjs` against a running app · output: [evidence/e2e-mock-output.txt](evidence/e2e-mock-output.txt)

Covers the minimums (agents, rooms, skills, permission levels), a plan with parallel tasks and saved charts, retry after a failure, reassignment after repeated failures, a failed plan reporting its reasons, the approval stop with preview, rejection enforcement, a mid-run instruction changing the plan, memory save / provenance / edit seen by another agent, the agent factory, and a workflow run with history, pause and resume.

## 3. Failure recovery (recorded plan logs)

**Retry, then success.** Instruction contained `!fail-once:research`.

```
T1 "Analyse the data" started by Dex.
T2 "Research the market" started by Scout.
T2 failed: Injected failure (fail-once) for "Research the market": the provider returned HTTP 503.
T2 will be retried (attempt 2 of 2).
T2 "Research the market" started by Scout (attempt 2).
T2 done by Scout.
```

**Repeated failure → reassignment; timeout; dependents skipped; plan reported as failed.** Instruction contained `!fail-always:research !slow:analyse`, task timeout set to 8 s.

```
T2 failed: Injected failure (fail-always) for "Research the market": the provider returned HTTP 503.
T2 will be retried (attempt 2 of 2).
T2 failed: Injected failure (fail-always) ...
T2 reassigned from Atlas to Vera after 2 failed attempts.
T2 "Research the market" started by Vera (attempt 3).
T2 failed: Injected failure (fail-always) ...
T1 timed out: No result after 8 seconds.
T1 will be retried (attempt 2 of 2).
T1 timed out: No result after 8 seconds.
T3 skipped: T1 timed-out, T2 failed.
T4 "Consolidate the final answer" started by Chief.
```

**Model fallback** (real-model path, local test server with one model that always answers HTTP 503):

```
Chief planned 3 tasks for Dex, Atlas (model ollama/planner).
Planning fell back from ollama/broken: The model is overloaded (fake 503).
T1 "Analyse the spreadsheet" started by Dex.
T1: ollama/broken failed, ollama/planner answered.
T1 done by Dex.
...
Audit: model-fallback  ollama/broken failed (The model is overloaded (fake 503).); trying ollama/planner.
Usage by model: ollama/planner, 5 calls, 5,400 input / 720 output tokens
```

**Restart in the middle of a plan.** The server was stopped while T3 waited for approval, then started again.

```
before restart:  T1 done · T2 done · T3 awaiting-approval · T4 pending
after restart:   plan interrupted · T3 interrupted ("Interrupted by a server restart.")
approvals:       [expired: "The app restarted before a decision was made."]
approving the expired request → refused: "This request is already expired."
"resume" →       Resumed after a restart. 2 finished tasks kept; the rest continue.
                 T3 "Send the email" started by Echo (attempt 2).  T3 is waiting for your approval.
after approval:  T3 done · T4 done · Plan done: 3 of 3 tasks done.
```

## 4. Approval enforcement (recorded)

**Rejected action did not execute.**

```
Approval:  Open a GitHub issue in Studio1-OSS/OpenCrewBot   status: pending  (preview shows repository, title and body)
Decision:  Reject
Plan log:  T3 done by Forge (1 action rejected and NOT executed).
Approval:  status rejected · executedAt: none
Audit:     rejected | Rejected by you: Open a GitHub issue in Studio1-OSS/OpenCrewBot ...
data/outbox: empty
Agent's reply: "NOT EXECUTED: rejected by the person. Nothing was sent or changed. ..."
```

**Approved action executed, and is labelled simulated because no token was set.**

```
Audit: approved | Approved by you: Send an email to founder@meetuniversity.com ...
Audit: executed | SIMULATED (the service is not connected): Gmail is not connected, so the email to
       founder@meetuniversity.com was NOT sent. It was saved to data/outbox/2026-11-14T10-12-39-705Z-email-59b63f.eml.
```

**Cancelled by a new instruction.** "Skip the email" arrived while the email waited for approval: the task was cancelled, the approval was marked cancelled, nothing was written to the outbox.

## 5. Verified with live models on a real machine (14 November 2026)

Run on Windows, in the fork's own clone, with a free **Groq** key and a free **Google Gemini** key in `.env`. The Models page showed both providers as configured, so the app was not in mock mode.

| Check | Result |
| --- | --- |
| `pnpm install` | 814 packages, no errors |
| `pnpm test` | **22 passed** |
| First real reply | The Chief answered a short question directly, with reasoning, instead of building a plan |
| Real planning | "Analyse the sales spreadsheet…" → 4 tasks across Dex, Vera and Atlas, **planned by `groq/openai/gpt-oss-120b`** |
| Real tool use | `analyze_spreadsheet` ran on the 600-row sample and returned the funnel: 600 leads → 438 contacted → 257 booked → 156 counselled → 104 proposals → 52 enrolled (8.7%), matching the unit tests exactly |
| Charts | 4 SVG charts saved as artifacts (funnel, by region, by channel, by product line) |
| Review loop | Vera answered **NEEDS CHANGES**; the engine automatically added **T5 "Revise: Sales Funnel and Conversion Analysis"** for the author, ran it, and only then consolidated |
| Consolidation | One report saved as an artifact, with a **"Not Completed"** section stating honestly what could not be verified |
| Cost | 199,667 tokens over the whole plan; $0.10 at list prices, $0 on Groq's free tier |
| **GitHub, live** | `github_inspect_repo` on `Studio1-OSS/OpenCrewBot` returned real API data (default branch, 17 stars, 1 open issue, description). A second call against a repository that was not publicly readable returned `GitHub 404: Not Found`, and the agent reported that plainly instead of inventing findings. |

### A bug this run found, and the fix

The first `analyze_spreadsheet` call was rejected:

```
Tool call validation failed: parameters for tool analyze_spreadsheet did not match schema:
errors: [missing properties: 'group_by', 'value_column', 'stage_column', 'stage_order',
         'date_column', 'filter_column', 'filter_equals']
```

Strict providers (Groq, OpenAI) validate a tool call against a schema in which **every** property is required, so a parameter declared with zod's `.optional()` and then left out by the model is rejected. All 19 optional tool parameters were changed to `.nullable()`, which keeps the property present and lets the model pass `null`; the implementations treat `null` as "not given". Re-tested afterwards on the same machine: `Analysed spreadsheet meetuniversity_sales_sample.csv ✓`.

This is also why the agent's recovery path matters: on the failed call the agent fell back to code mode and still produced the correct numbers, so the task completed rather than failing.

In the same run the reviewer agent asked for the CSV to be uploaded, because it had no data tool and so could not re-compute the author's numbers. The seeded reviewer now has `dataAnalysis` and `codeMode`, and its instructions tell it to re-run numbers itself.

## 6. Static checks

`pnpm typecheck` (TypeScript, no errors) · `pnpm lint` (ESLint, no errors or warnings) · `pnpm build` compiles all routes and pages.

## Not covered by these runs

- Writing to GitHub (opening an issue) with a token. Reading is verified live; the write path is covered by the simulated run and the approval tests.
- DuckDuckGo web search, Gmail SMTP, Slack, Notion and MCP servers. Their simulated paths are covered, but no live call to those services has been made yet.

To close these gaps: press **Test connection** on the Integrations page for each service you configure, run demos 1, 4, 5 and 7 in [DEMO_SCRIPT.md](DEMO_SCRIPT.md), and add what you observe to this file.
