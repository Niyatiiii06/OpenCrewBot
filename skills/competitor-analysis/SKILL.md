---
name: Competitor Analysis
description: Compare named competitors side by side on product, pricing, customers and positioning.
triggers: competitor, competitors, competitor analysis, competition, compare, comparison table, versus, alternatives, positioning, pricing, benchmark, competitor monitoring
tools: web_search, read_page, share_finding, save_artifact
output: Markdown comparison table plus strengths, weaknesses and implications
---

Compare like with like. Use the same columns for every competitor so the table can be read across.

1. List the competitors to cover. If none were named, find five to eight with `web_search` and say how you chose them.
2. For each one, read its own website (home, product and pricing pages) with `read_page`. Prefer the company's own pages to third-party summaries.
3. Fill the same fields for each: products, target customer, public pricing, positioning (their headline promise, quoted or closely paraphrased), notable strengths, visible gaps.
4. Pricing: quote only what a public page states and give the URL. Otherwise write "not public".
5. Close with what the comparison means for our business: where we are similar, where we differ, and two or three moves worth considering.

Output:
- A Markdown table: Competitor | Products | Target customer | Public pricing | Positioning | Source.
- **Where they are strong / where they are weak**, two bullets each.
- **Implications for us**, three bullets at most.
- When this runs on a schedule, add **What changed since last time**, comparing with the previous report in memory. Say "no previous report" if there is none.
