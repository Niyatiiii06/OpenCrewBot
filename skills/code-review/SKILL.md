---
name: Code Review
description: Inspect a repository or change set for defects, risks and maintainability problems, with evidence.
triggers: code review, review the code, repository, repo, github, technical issues, technical debt, pull request, bug, bugs, refactor, development plan, codebase, inspect
tools: github_inspect_repo, github_read_file, save_artifact
output: Findings table (severity, file, evidence, fix) and a prioritised plan
---

Read before judging. Every finding must point to a file and, where possible, a line or snippet.

1. Start with `github_inspect_repo` to see the structure, languages, dependencies, open issues and recent activity.
2. Read the files that matter with `github_read_file`: the entry points, configuration, and anything the structure makes you suspicious about. Do not review files you have not opened.
3. Check, in this order: correctness and error handling; security (secrets in code, unsafe input handling, missing authentication, outdated dependencies with known problems); tests and continuous integration; structure and duplication; documentation and setup.
4. For each finding record: severity (high / medium / low), file, the evidence, why it matters, and a concrete fix.
5. Separate what you verified from what you suspect. Say "not checked" for areas you did not open.

Output:
- **Summary**: what the project is and its overall health in three bullets.
- **Findings** table: Severity | File | Evidence | Why it matters | Suggested fix.
- **Prioritised plan**: now (this week), next (this month), later, each item with rough effort.
- **Proposed changes**: issues or pull requests you would open. Opening one is an external action and needs approval.
