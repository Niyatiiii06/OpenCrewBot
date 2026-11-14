---
name: Repository Monitoring
description: Summarise what changed in a repository: commits, issues and pull requests since the last check.
triggers: repository monitoring, repo monitoring, monitor the repo, what changed in the repo, recent commits, new issues, release notes, changelog
tools: github_inspect_repo, save_artifact
output: Short digest: new commits, new and closed issues, things that need attention
---

Report change, not state.

1. Run `github_inspect_repo` and read the recent commits, open issues and pull requests.
2. Compare with the last digest in memory. If there is none, say so and treat this run as the baseline.
3. Summarise: new commits (grouped by theme), issues opened and closed, pull requests waiting for review, and anything that looks risky (failing checks, large unreviewed changes, security-related issues).
4. Finish with what needs a human decision, if anything.

Keep it under 300 words. Save the digest so the next run can compare against it.
