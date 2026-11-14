# How it works, in plain words

A guide for explaining the project out loud. Each section is one idea, the file it lives in, and a sentence you can say.

## The one-line version

"The original app was a chat with separate bots. I added a manager agent that turns one instruction into a tracked task plan, an engine that runs those tasks across the team with retries and approvals, shared memory in Markdown files, a skill library, direct integrations, schedules, and multi-provider model routing with fallback."

## 1. What I started from

The original app already had: bots with their own model, tools and `MEMORY.md`; rooms with @mentions; approval cards for browser actions; one model provider (Nebius). It had no planning, no tasks, no shared memory, no skills, no schedules.

I kept all of it. A task in my engine is just a normal bot turn in a normal room, so everything the original shows in chat (tool steps, approvals, streaming) still works for tasks.

## 2. The Chief of Staff (`planner.ts`)

"When a message arrives in a room run by the Chief, I ask the model for a plan as JSON: a list of tasks, each with an agent, the tasks it depends on, and whether it needs approval. I validate that JSON with zod, because models make mistakes: unknown agents are re-matched, bad dependencies are dropped, cycles are broken."

"If there is no model, or its plan is unusable, a rule-based planner takes over. It recognises kinds of work from the wording, such as data, repository, research, campaign, email, and builds the plan from those. So the system degrades instead of stopping."

How an agent is chosen: a score. Has the tool the task needs (+6), carries the skill (+4), role words match (+1 each). Highest score wins.

## 3. The execution engine (`engine.ts`)

Think of a to-do list where some items wait for others.

- A task is **ready** when everything it depends on has ended.
- The engine starts every ready task, up to three at once. That is the parallelism.
- When a task ends, the loop wakes up and looks again.

Failure handling, in order: retry (on another model if the provider failed) → reassign to another agent with the same tool → mark failed. Work that depended only on failed tasks is skipped. The final report always says what was not completed.

"Every change is saved to SQLite, so after a restart I can see which plans were running, mark them interrupted, and resume: finished tasks keep their results, the rest run again."

Interruption: "A new message while a plan runs is added to the plan as a new instruction. The Chief decides what to cancel and what to add. Tasks that have not started see the new instruction; the final answer is rewritten if it had already begun."

## 4. Approvals (`permissions.ts`)

"Every tool that acts outside the app calls one function, `gate()`, before doing anything. If the gate does not return allowed, the code that sends the email is never reached. That is why a rejected action cannot run: it is not a flag the model is asked to respect, it is control flow."

Three levels: Ask first (always ask), Controlled (run only pre-approved actions, such as email to an approved domain, and only up to a limit per run), Full access (run). A per-tool setting can override the level. Everything is written to an audit log.

After a restart, waiting approvals are marked expired, so an old request can never be approved late.

## 5. Memory (`memory-files.ts`)

Six kinds of Markdown file: each agent's own notes, room notes, project facts, your preferences, decisions, work history.

"The system prompt is rebuilt on every model call and reads those files from disk each time. So memory survives a restart, because it is just files, and if someone edits a file, the very next reply uses the new text."

Provenance: every write also stores who wrote it, when, why and where it came from.

## 6. Skills (`skills.ts`, `skills/`)

A skill is a Markdown file of instructions for one kind of work, with trigger words. Agents see a one-line index of all skills. The full text is loaded only when needed: pinned on the agent, matched to a task by trigger words, or requested by the agent with `use_skill`. This keeps prompts short. Adding a skill is adding a file, with no restart.

## 7. Agents talking to each other (`collab.ts`)

Tools: ask a teammate, request verification, challenge a conclusion, delegate a task, share a finding.

Loop prevention, which interviewers like to ask about:
- an agent cannot ask itself;
- a chain of questions stops at depth 2;
- before A waits for B, I check that B is not already waiting (directly or indirectly) for A, which would deadlock;
- each plan has a budget of delegations and agent-to-agent messages;
- every question has a time limit.

## 8. Models (`providers.ts`, `runtime.ts`)

"For each turn I build an ordered list of models: the agent's own, its fallbacks, then the same tier on other providers. If a call fails before producing output, I retry the same turn on the next model and record it."

Routing: agents set to Auto get a fast model for short questions, a balanced one for research and review, a strong one for planning and the final report.

## 9. Integrations and honesty (`integrations.ts`)

GitHub by REST, Gmail by SMTP, Slack by webhook, Notion by API, MCP from the original app. "If a service is not connected, the action still goes through approval, then it is saved to an outbox folder and labelled SIMULATED everywhere. Nothing claims to have been sent when it was not."

## 10. Mock mode (`mock-model.ts`)

"With no model key, a scripted model stands in. It cannot write, but it calls the real tools and the real engine runs, so planning, parallel tasks, retries, approvals, memory and schedules can all be shown and tested. Every reply says it is the mock."

## Questions you may get

**Why Markdown files for memory instead of a vector database?** They are readable, editable by a person, diff-able, and need no extra service. For this scale, reading a few small files per turn is cheap. A vector store would matter with thousands of notes.

**Why SQLite?** The original used it, it needs no setup, and it is enough for one user on one machine. Plans are stored as JSON rows so the schema is easy to change.

**Why a rule planner at all?** Reliability. Free models hit rate limits and sometimes return broken JSON. The work should still proceed.

**What stops an agent from ignoring a rejection?** It cannot act: the send function is only called after the gate returns allowed. The model is also told not to retry, but safety does not depend on that.

**What would you do next?** Run tasks in isolated sessions so a running task can take a new instruction; a real job queue so schedules survive downtime; pull requests instead of only issues; sign-in and per-user data.

**What is not verified?** Say it directly: the live integrations and real model providers were to be verified with my own keys; the simulated paths, the engine and the approval gate are covered by 22 unit tests and 29 end-to-end checks.
