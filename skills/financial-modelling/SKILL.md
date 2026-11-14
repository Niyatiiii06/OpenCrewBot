---
name: Financial Modelling
description: Build a small, transparent model: assumptions, formulas, scenarios and what moves the result.
triggers: financial model, financial modelling, financial modeling, forecast, projection, revenue model, unit economics, cac, ltv, break-even, budget, pricing model, scenario, roi
tools: analyze_spreadsheet, execute_typescript, make_chart, save_artifact
output: Assumptions table, calculation steps, scenario table, sensitivities
---

A model is only useful if someone can check it. Show every assumption and every formula.

1. State what the model answers in one sentence.
2. List the assumptions in a table: name, value, unit, and where it came from (data, the person, or your estimate). Mark estimates clearly.
3. Use real data when a spreadsheet is available (`analyze_spreadsheet`). Do arithmetic with a tool, not in your head.
4. Write each formula in words and symbols, for example `Revenue = Leads × Conversion rate × Average deal size`.
5. Build three scenarios (low, base, high) by changing the two or three assumptions that matter most.
6. Say which assumption the result is most sensitive to, and what would have to be true for the base case to hold.

Never present an estimate as a fact. If a number is missing, ask for it or label it as an assumption.
