# Demo script

Seven demonstrations for the video (5 to 10 minutes), then a rehearsal of the final evaluation. Use real model keys for the recording so answers are real; say so when a step is simulated.

Before recording: `pnpm dev`, open http://localhost:3000, check the Models page shows your providers as configured, and press **Test connection** on the Integrations you set up.

## 0. Thirty-second tour

Sidebar → nine agents and six rooms. Open the workspace pages once: Tasks, Approvals, Memory, Skills & tools, Integrations (point at LIVE / SIMULATED badges), Models, Workflows, History.

## 1. Market intelligence

Room: **Market Intelligence**.

> Research the study-abroad market for Indian Class 11 students: demand trends, top destinations, and what our three closest competitors offer. Tell me where MeetUniversity should focus.

Show: the plan card (tasks, agents, which run in parallel), Scout's search steps and sources, Vera's verification, the consolidated report, the Tasks page.

## 2. Class 11 Aspirations campaign

Room: **Campaign Studio**.

> Create a "Class 11 Aspirations" campaign for MeetUniversity with a 30-day content calendar as a table: day, channel, format, hook, call to action.

Show: skills loaded on the task (campaign-strategy, content-calendar) in the task details, the calendar table in the report.

## 3. Sales spreadsheet

Room: **Sales and Data**. (The sample file is synthetic; say so, or upload a real CSV on Skills & tools.)

> Analyse the sales spreadsheet meetuniversity_sales_sample.csv. Where is the funnel leaking, which channels and regions convert best, and what three actions should we take?

Show: the `analyze_spreadsheet` step, the funnel table with the calculated percentages, the charts, the recommendations.

## 4. GitHub repository, approval before changes

Room: **Engineering**.

> Inspect the repository github.com/<your-username>/OpenCrewBot, review its structure and code quality, and open an issue for the most important finding.

Use **your own** repository here. Opening an issue on somebody else's repository posts to their project, and the original authors did not ask for automated issues.

Show: the inspection findings with evidence; the plan stopping at "Needs approval"; the preview of the exact issue; press **Approve** (with a `GITHUB_TOKEN` the issue is created in your repository; without one it is saved to `data/outbox` and labelled SIMULATED).

Reading a repository needs no token, but it must be **public** (a private repository answers 404 to an anonymous request, which the agent will report honestly). To read a private repository, put a token in `.env` or on the Integrations page.

## 5. Recurring competitor monitoring

Workflows page → name "Competitor watch", room Market Intelligence, schedule `every 2 minutes` (for the demo), instruction:

> Check what our main competitors in study-abroad counselling published or changed recently and write a short report with sources.

Press **Run now**. Show the run in the room, then Run history with the report, then let the schedule fire once, then **Pause**.

## 6. Memory persists and respects edits

1. Direct message to Quill: `remember that I prefer answers under 100 words with a table`.
2. Memory page → Your preferences: the line, and the provenance row (who, why, source).
3. Stop the server (Ctrl+C), run `pnpm dev` again.
4. Direct message to Scout (a different agent): `what do you remember about how I like answers?`
5. Memory page → change the line to `Always answer in bullet points` → Save.
6. Ask Scout again. The answer follows the edited text.

## 7. Reject an external action

Room: **Sales and Data**.

> Analyse the sales spreadsheet and email a three-line summary to founder@meetuniversity.com

When the approval card appears, press **Reject**. Show: the tool step marked "Rejected · not executed", the agent's reply saying it was not sent, Approvals → Decisions ("No. Never ran."), the audit log entry, and that `data/outbox` has no new file (and no email arrived).

## Failure handling (30 seconds)

With a real model: set a wrong model as an agent's fixed model on the Models page, send a message, and show "fell back from …" under the reply and the audit entry. In mock mode: add `!fail-once:research` to an instruction and show the retry in the plan log.

## Final evaluation rehearsal

The evaluators will give a new business problem. Practise this sequence:

1. **Create agents**: + → New agent → describe it → Draft agent → review → Create. Do this twice.
2. **Create a room**: + → New room → add the Chief and the agents → set "Who answers" to **Chief of Staff**.
3. **One complex instruction** in that room.
4. Watch the **plan**, the **delegation**, the **tool steps**.
5. **Approve or reject** when asked.
6. **Interrupt**: send a new instruction while it runs. The Chief posts what changed.
7. If they **edit an agent's memory** mid-run (Memory page): tasks that start after the edit use the new text, because memory is read from disk on every model call.
8. Open the **consolidated report**.
