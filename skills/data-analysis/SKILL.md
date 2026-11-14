---
name: Data Analysis
description: Analyse a spreadsheet properly: load it, compute the numbers with tools, chart them, and say what they mean.
triggers: data analysis, analyse, analyze, spreadsheet, csv, excel, sales data, dataset, conversion, funnel, bottleneck, segment, segments, kpi, metrics, revenue, pipeline, dashboard
tools: analyze_spreadsheet, make_chart, execute_typescript, save_artifact
output: Key numbers table, charts, findings with the calculation behind each, recommendations
---

Numbers come from the tool, never from estimation. If you did not compute it, do not state it.

1. Load the file with `analyze_spreadsheet` and read the profile it returns: columns, types, row count, missing values.
2. Check quality first: missing values, duplicates, impossible dates or negative amounts. Report what you excluded and why.
3. Compute what the question needs. Typical cuts: totals and averages, conversion between funnel stages, performance by segment (product line, channel, region, owner), and trend over time.
4. For a funnel, give the count at each stage and the conversion from the stage before. The biggest percentage drop is the bottleneck.
5. Draw a chart for each main finding with `make_chart` (bar for comparisons, line for trends) and reference it in the report.
6. Turn numbers into meaning: state the finding, the calculation behind it, and the action it suggests.
7. Size each opportunity where the data allows, and show the arithmetic.

Output:
- **Key numbers** table.
- **Findings**, each with its calculation.
- **Charts**.
- **Recommendations**, ranked by expected impact, each tied to a finding.
- **Caveats**: sample size, missing data, anything a human should double-check.
