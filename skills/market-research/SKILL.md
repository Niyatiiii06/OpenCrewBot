---
name: Market Research
description: Size up a market: who is in it, who buys, what is changing, and where the openings are.
triggers: market research, market intelligence, market landscape, competitive landscape, industry, market size, tam, trends, market opportunity, market opportunities, landscape
tools: web_search, read_page, share_finding, save_artifact
output: Markdown report: summary, market map, evidence table with source URLs, opportunities
---

Work from evidence, not memory. Every claim about a company, a price or a number needs a source URL next to it.

1. Frame the market in one sentence: who the customer is, what job they need done, and which geography.
2. Search for the players. Run several different searches (category terms, "alternatives to", "top platforms for"), not one.
3. Open the most relevant pages with `read_page`. A search snippet is a lead, not evidence.
4. Record for each player: what they sell, who they sell it to, how they charge (only if a public page states it), and how they position themselves.
5. Note what you could not verify. Write "not publicly stated" instead of estimating a price or a user count.
6. Look for gaps: customer groups nobody serves well, promises every player makes (so none stands out), and things customers complain about.
7. Share the key findings with `share_finding` so teammates can build on them.

Report structure:
- **Summary**: five bullets at most.
- **Market map**: the segments and who sits in each.
- **Evidence table**: player, offer, target customer, public pricing, positioning, source URL.
- **Opportunities**: each with the evidence that suggests it and how sure you are (high / medium / low).
- **Open questions**: what a human should check.
