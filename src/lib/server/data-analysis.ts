// Spreadsheet analysis and charts. Everything here is computed, not generated:
// the numbers an agent reports come from these functions, so they are the same
// whether a real model or the mock model is driving.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UPLOADS_DIR } from "./config";

const SAMPLES_DIR = resolve(/*turbopackIgnore: true*/ process.cwd(), "samples");

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Table {
  file: string;
  columns: string[];
  rows: Row[];
}

// ── loading ─────────────────────────────────────────────────────────────

/** A small CSV reader that handles quoted fields, embedded commas, and both line endings. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

function toCell(raw: string): Cell {
  const value = raw.trim();
  if (value === "") return null;
  const numeric = value.replace(/[₹$€£,\s]/g, "").replace(/%$/, "");
  if (/^-?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
  return value;
}

/** Files the workforce may read: what you uploaded, and the samples shipped with the repo. */
export function listDataFiles(): { name: string; where: "uploads" | "samples" }[] {
  const out: { name: string; where: "uploads" | "samples" }[] = [];
  for (const [dir, where] of [[UPLOADS_DIR, "uploads"], [SAMPLES_DIR, "samples"]] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (/\.(csv|tsv|txt)$/i.test(name)) out.push({ name, where });
  }
  return out;
}

/** Find a data file by name. Only the upload folder and the samples folder are searched,
 * and only the file's base name is used, so a tool call can't read anything else on disk. */
export function resolveDataFile(name: string): string | null {
  const file = basename(name.trim());
  for (const dir of [UPLOADS_DIR, SAMPLES_DIR]) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  // A loose match helps when the model shortens the name ("sales" → "…sales_sample.csv").
  const wanted = file.toLowerCase().replace(/\.(csv|tsv|xlsx?)$/, "");
  const match = listDataFiles().find((f) => f.name.toLowerCase().includes(wanted));
  return match ? join(match.where === "uploads" ? UPLOADS_DIR : SAMPLES_DIR, match.name) : null;
}

export function loadTable(name: string): Table {
  const path = resolveDataFile(name);
  if (!path) {
    const known = listDataFiles().map((f) => f.name).join(", ") || "none";
    throw new Error(`No data file named "${name}". Available files: ${known}. Upload a CSV in Skills & Tools → Data files.`);
  }
  const text = readFileSync(path, "utf8");
  const delimiter = /\.tsv$/i.test(path) || (text.split("\n")[0].includes("\t") && !text.split("\n")[0].includes(",")) ? "\t" : ",";
  const raw = parseCsv(text, delimiter);
  if (raw.length < 2) throw new Error(`"${basename(path)}" has no data rows.`);
  const columns = raw[0].map((c, i) => c.trim() || `column_${i + 1}`);
  const rows = raw.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, toCell(r[i] ?? "")])) as Row);
  return { file: basename(path), columns, rows };
}

// ── profiling ───────────────────────────────────────────────────────────

export interface ColumnProfile {
  name: string;
  type: "number" | "date" | "text";
  missing: number;
  distinct: number;
  sum?: number;
  mean?: number;
  median?: number;
  min?: number;
  max?: number;
  /** Most common values of a text column. */
  top?: { value: string; count: number }[];
}

const isDate = (v: Cell) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function profile(table: Table): ColumnProfile[] {
  return table.columns.map((name) => {
    const values = table.rows.map((r) => r[name]);
    const present = values.filter((v) => v !== null);
    const numbers = present.filter((v): v is number => typeof v === "number");
    const distinct = new Set(present.map(String)).size;
    const base = { name, missing: values.length - present.length, distinct };
    if (present.length && numbers.length / present.length > 0.9) {
      const sum = numbers.reduce((a, b) => a + b, 0);
      return { ...base, type: "number", sum: round(sum), mean: round(sum / numbers.length), median: round(median(numbers)), min: Math.min(...numbers), max: Math.max(...numbers) };
    }
    if (present.length && present.filter(isDate).length / present.length > 0.9) {
      const dates = present.map(String).sort();
      return { ...base, type: "date", top: [{ value: `${dates[0].slice(0, 10)} to ${dates[dates.length - 1].slice(0, 10)}`, count: present.length }] };
    }
    const counts = new Map<string, number>();
    for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }));
    return { ...base, type: "text", top };
  });
}

// ── calculations ────────────────────────────────────────────────────────

export interface GroupRow {
  group: string;
  count: number;
  sum: number | null;
  mean: number | null;
  /** Share of rows that reached the final funnel stage, when a funnel is known. */
  winRate: number | null;
  /** Rows that reached the final stage, and the value they carry (won revenue). */
  won: number | null;
  wonSum: number | null;
}

export function groupBy(table: Table, column: string, valueColumn?: string, won?: (row: Row) => boolean): GroupRow[] {
  const groups = new Map<string, { count: number; sum: number; n: number; won: number; wonSum: number }>();
  for (const row of table.rows) {
    const key = row[column] === null ? "(blank)" : String(row[column]);
    const g = groups.get(key) ?? { count: 0, sum: 0, n: 0, won: 0, wonSum: 0 };
    g.count++;
    const v = valueColumn ? row[valueColumn] : null;
    if (typeof v === "number") {
      g.sum += v;
      g.n++;
    }
    if (won?.(row)) {
      g.won++;
      if (typeof v === "number") g.wonSum += v;
    }
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([group, g]) => ({
      group,
      count: g.count,
      sum: valueColumn ? round(g.sum) : null,
      mean: valueColumn && g.n ? round(g.sum / g.n) : null,
      winRate: won ? round((100 * g.won) / g.count, 1) : null,
      won: won ? g.won : null,
      wonSum: won && valueColumn ? round(g.wonSum) : null,
    }))
    .sort((a, b) => (b.wonSum ?? b.sum ?? b.count) - (a.wonSum ?? a.sum ?? a.count));
}

/** Stage names seen in sales and admissions data, earliest first. Used to order a funnel
 * when the caller does not give the order. */
const KNOWN_STAGE_ORDER = [
  "lead", "new", "enquiry", "inquiry", "contacted", "engaged", "qualified", "counselling booked", "counseling booked", "demo booked",
  "meeting booked", "counselling done", "counseling done", "demo done", "meeting done", "application started", "proposal", "proposal sent",
  "negotiation", "application submitted", "offer", "won", "closed won", "enrolled", "paid", "customer",
];
const LOST = /^(lost|closed lost|dropped|churned|disqualified|rejected)$/i;

export interface FunnelStage {
  stage: string;
  reached: number;
  /** Percent of the previous stage that got here. */
  fromPrevious: number | null;
  /** Percent of the first stage that got here. */
  fromStart: number;
  dropped: number;
}

/** Each row carries the furthest stage it reached. A row counts for its own stage and
 * every stage before it, so the funnel shows how many got at least that far. */
export function funnel(table: Table, stageColumn: string, order?: string[]): { stages: FunnelStage[]; bottleneck: FunnelStage | null; order: string[] } {
  const seen = [...new Set(table.rows.map((r) => r[stageColumn]).filter((v): v is string => typeof v === "string" && !LOST.test(v)))];
  const rank = (s: string) => {
    const i = KNOWN_STAGE_ORDER.indexOf(s.toLowerCase());
    return i === -1 ? 500 : i;
  };
  const ordered = order?.length ? order.filter((s) => seen.some((x) => x.toLowerCase() === s.toLowerCase())) : seen.sort((a, b) => rank(a) - rank(b));
  const index = new Map(ordered.map((s, i) => [s.toLowerCase(), i]));
  const reached = ordered.map(() => 0);
  for (const row of table.rows) {
    const v = row[stageColumn];
    if (typeof v !== "string") continue;
    const i = index.get(v.toLowerCase());
    if (i === undefined) continue;
    for (let k = 0; k <= i; k++) reached[k]++;
  }
  const stages: FunnelStage[] = ordered.map((stage, i) => ({
    stage,
    reached: reached[i],
    fromPrevious: i === 0 || reached[i - 1] === 0 ? null : round((100 * reached[i]) / reached[i - 1], 1),
    fromStart: reached[0] ? round((100 * reached[i]) / reached[0], 1) : 0,
    dropped: i === 0 ? 0 : reached[i - 1] - reached[i],
  }));
  const steps = stages.slice(1).filter((s) => s.fromPrevious !== null);
  const bottleneck = steps.length ? steps.reduce((worst, s) => ((s.fromPrevious ?? 100) < (worst.fromPrevious ?? 100) ? s : worst)) : null;
  return { stages, bottleneck, order: ordered };
}

export function trend(table: Table, dateColumn: string, valueColumn?: string): { period: string; count: number; sum: number | null }[] {
  const months = new Map<string, { count: number; sum: number }>();
  for (const row of table.rows) {
    const d = row[dateColumn];
    if (!isDate(d)) continue;
    const key = String(d).slice(0, 7);
    const m = months.get(key) ?? { count: 0, sum: 0 };
    m.count++;
    const v = valueColumn ? row[valueColumn] : null;
    if (typeof v === "number") m.sum += v;
    months.set(key, m);
  }
  return [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, m]) => ({ period, count: m.count, sum: valueColumn ? round(m.sum) : null }));
}

// ── a full analysis in one call ─────────────────────────────────────────

export interface AnalysisRequest {
  file: string;
  groupBy?: string[];
  valueColumn?: string;
  stageColumn?: string;
  stageOrder?: string[];
  dateColumn?: string;
  filter?: { column: string; equals: string };
}

export interface Analysis {
  file: string;
  rows: number;
  columns: ColumnProfile[];
  valueColumn: string | null;
  stageColumn: string | null;
  funnel: ReturnType<typeof funnel> | null;
  groups: { column: string; rows: GroupRow[] }[];
  trend: { column: string; rows: ReturnType<typeof trend> } | null;
  /** Rows at the final stage and the value they carry, when both are known. */
  won: { stage: string; count: number; value: number | null; rate: number } | null;
  quality: string[];
  /** The same results as readable Markdown, ready to quote in a report. */
  markdown: string;
}

const pick = (columns: ColumnProfile[], type: ColumnProfile["type"], pattern: RegExp) =>
  columns.find((c) => c.type === type && pattern.test(c.name)) ?? null;

const money = (n: number | null) => (n === null ? "" : n.toLocaleString("en-IN", { maximumFractionDigits: 0 }));

function mdTable(headers: string[], rows: (string | number | null)[][]): string {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => (c === null ? "" : c)).join(" | ")} |`)].join("\n");
}

/** Profile the file and run every cut that makes sense for it. Columns are detected
 * from the data when the caller does not name them. */
export function analyze(request: AnalysisRequest): Analysis {
  let table = loadTable(request.file);
  if (request.filter) {
    const { column, equals } = request.filter;
    if (!table.columns.includes(column)) throw new Error(`No column "${column}". Columns: ${table.columns.join(", ")}.`);
    table = { ...table, rows: table.rows.filter((r) => String(r[column] ?? "").toLowerCase() === equals.toLowerCase()) };
  }
  const columns = profile(table);
  const named = (name?: string) => (name ? columns.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null : null);

  const value = named(request.valueColumn) ?? pick(columns, "number", /value|revenue|amount|price|deal|fee|sales|total/i);
  const stage = named(request.stageColumn) ?? pick(columns, "text", /stage|status|step|phase/i);
  const date = named(request.dateColumn) ?? pick(columns, "date", /.*/);

  const f = stage ? funnel(table, stage.name, request.stageOrder) : null;
  const finalStage = f?.order[f.order.length - 1]?.toLowerCase();
  const won = stage && finalStage ? (row: Row) => String(row[stage.name] ?? "").toLowerCase() === finalStage : undefined;

  const wanted = request.groupBy?.length
    ? request.groupBy.map((g) => named(g)).filter((c): c is ColumnProfile => Boolean(c))
    : columns.filter((c) => c.type === "text" && c.distinct >= 2 && c.distinct <= 12 && c.name !== stage?.name && !/id$|name$|email|phone/i.test(c.name));
  const groups = wanted.map((c) => ({ column: c.name, rows: groupBy(table, c.name, value?.name, won) }));
  const t = date ? { column: date.name, rows: trend(table, date.name, value?.name) } : null;

  const quality: string[] = [];
  for (const c of columns) if (c.missing) quality.push(`${c.name}: ${c.missing} missing of ${table.rows.length}`);
  const ids = columns.find((c) => /id$/i.test(c.name));
  if (ids && ids.distinct < table.rows.length - ids.missing) quality.push(`${ids.name}: ${table.rows.length - ids.missing - ids.distinct} duplicate ids`);
  if (!quality.length) quality.push("No missing values or duplicate ids found.");

  const parts: string[] = [`**File:** ${table.file} · **Rows:** ${table.rows.length} · **Columns:** ${table.columns.join(", ")}`];
  parts.push(`**Data quality:** ${quality.join("; ")}`);
  let wonTotal: Analysis["won"] = null;
  if (won && f) {
    const wonRows = table.rows.filter(won);
    const wonValue = value ? round(wonRows.reduce((a, r) => a + (typeof r[value.name] === "number" ? (r[value.name] as number) : 0), 0)) : null;
    wonTotal = { stage: f.order[f.order.length - 1], count: wonRows.length, value: wonValue, rate: table.rows.length ? round((100 * wonRows.length) / table.rows.length, 1) : 0 };
  }
  if (value) parts.push(`**${value.name}:** total across all rows ${money(value.sum ?? 0)}, average ${money(value.mean ?? 0)}, median ${money(value.median ?? 0)}, range ${money(value.min ?? 0)} to ${money(value.max ?? 0)}`);
  if (wonTotal) parts.push(`**Won (${wonTotal.stage}):** ${wonTotal.count} of ${table.rows.length} rows (${wonTotal.rate}%)${wonTotal.value !== null ? `, worth ${money(wonTotal.value)}` : ""}`);
  if (f?.stages.length) {
    parts.push(
      `**Funnel by ${stage!.name}** (rows that reached at least each stage)\n\n` +
        mdTable(["Stage", "Reached", "% of previous stage", "% of start", "Dropped before this stage"], f.stages.map((s) => [s.stage, s.reached, s.fromPrevious === null ? "" : `${s.fromPrevious}%`, `${s.fromStart}%`, s.dropped])),
    );
    if (f.bottleneck) {
      const before = f.stages[f.stages.indexOf(f.bottleneck) - 1];
      parts.push(`**Biggest drop:** ${before.stage} → ${f.bottleneck.stage}: only ${f.bottleneck.fromPrevious}% continue (${f.bottleneck.dropped} of ${before.reached} lost).`);
    }
  }
  for (const g of groups) {
    const last = f?.order[f.order.length - 1];
    const headers = ["" + g.column, "Rows", ...(won ? [`${last}`, `% reaching ${last}`] : []), ...(won && value ? [`${value.name} won`] : []), ...(value ? [`${value.name} all rows`] : [])];
    parts.push(
      `**By ${g.column}**\n\n` +
        mdTable(headers, g.rows.map((r) => [r.group, r.count, ...(won ? [r.won, `${r.winRate}%`] : []), ...(won && value ? [money(r.wonSum)] : []), ...(value ? [money(r.sum)] : [])])),
    );
  }
  if (t?.rows.length) parts.push(`**By month (${t.column})**\n\n` + mdTable(["Month", "Rows", ...(value ? [`Total ${value.name}`] : [])], t.rows.map((r) => [r.period, r.count, ...(value ? [money(r.sum)] : [])])));

  return { file: table.file, rows: table.rows.length, columns, valueColumn: value?.name ?? null, stageColumn: stage?.name ?? null, funnel: f, groups, trend: t, won: wonTotal, quality, markdown: parts.join("\n\n") };
}

// ── charts ──────────────────────────────────────────────────────────────

export interface ChartSpec {
  title: string;
  type: "bar" | "line";
  labels: string[];
  values: number[];
  /** What the numbers are, shown under the title. */
  unit?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (n: number) => (Math.abs(n) >= 1e7 ? `${round(n / 1e7, 1)} Cr` : Math.abs(n) >= 1e5 ? `${round(n / 1e5, 1)} L` : Math.abs(n) >= 1e3 ? `${round(n / 1e3, 1)}k` : String(round(n, 1)));

/** A self-contained SVG chart: no library, opens in any browser, embeds in Markdown. */
export function chartSvg(spec: ChartSpec): string {
  const labels = spec.labels.slice(0, 24);
  const values = spec.values.slice(0, labels.length).map((v) => (Number.isFinite(v) ? v : 0));
  if (!labels.length || values.length !== labels.length) throw new Error("A chart needs the same number of labels and values (1 to 24).");
  const W = 760;
  const max = Math.max(...values, 0) || 1;
  const head = `<text x="24" y="34" font-size="17" font-weight="600" fill="#111827">${esc(spec.title)}</text>` + (spec.unit ? `<text x="24" y="54" font-size="12" fill="#6b7280">${esc(spec.unit)}</text>` : "");
  let body = "";
  let H: number;
  if (spec.type === "line") {
    H = 360;
    const left = 64, right = 24, top = 76, bottom = 56;
    const pw = W - left - right, ph = H - top - bottom;
    const x = (i: number) => left + (labels.length === 1 ? pw / 2 : (pw * i) / (labels.length - 1));
    const y = (v: number) => top + ph - (ph * v) / max;
    for (let k = 0; k <= 4; k++) {
      const gy = top + (ph * k) / 4;
      body += `<line x1="${left}" y1="${gy}" x2="${W - right}" y2="${gy}" stroke="#e5e7eb"/><text x="${left - 8}" y="${gy + 4}" font-size="11" text-anchor="end" fill="#6b7280">${short(max - (max * k) / 4)}</text>`;
    }
    body += `<polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${values.map((v, i) => `${round(x(i), 1)},${round(y(v), 1)}`).join(" ")}"/>`;
    const every = Math.ceil(labels.length / 12);
    values.forEach((v, i) => {
      body += `<circle cx="${round(x(i), 1)}" cy="${round(y(v), 1)}" r="3.5" fill="#2563eb"/>`;
      if (i % every === 0) body += `<text x="${round(x(i), 1)}" y="${H - 30}" font-size="11" text-anchor="middle" fill="#374151">${esc(labels[i].slice(0, 12))}</text>`;
    });
  } else {
    const rowH = 30, top = 72, left = 190, right = 80;
    H = top + rowH * labels.length + 24;
    const pw = W - left - right;
    labels.forEach((label, i) => {
      const y = top + rowH * i;
      const w = Math.max(2, (pw * values[i]) / max);
      body += `<text x="${left - 10}" y="${y + 19}" font-size="12.5" text-anchor="end" fill="#374151">${esc(label.slice(0, 26))}</text>`;
      body += `<rect x="${left}" y="${y + 5}" width="${round(w, 1)}" height="20" rx="3" fill="#2563eb"/>`;
      body += `<text x="${round(left + w + 8, 1)}" y="${y + 19}" font-size="12" fill="#111827">${short(values[i])}</text>`;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif"><rect width="${W}" height="${H}" rx="10" fill="#ffffff"/>${head}${body}</svg>`;
}

/** The charts that go with a full analysis: the funnel, each segment cut, and the trend. */
export function chartsFor(analysis: Analysis): ChartSpec[] {
  const charts: ChartSpec[] = [];
  if (analysis.funnel?.stages.length) {
    charts.push({ title: "Sales funnel: leads reaching each stage", type: "bar", labels: analysis.funnel.stages.map((s) => s.stage), values: analysis.funnel.stages.map((s) => s.reached), unit: "Number of leads" });
  }
  for (const g of analysis.groups.slice(0, 3)) {
    const hasRate = g.rows.some((r) => r.winRate !== null);
    const last = analysis.funnel?.order[analysis.funnel.order.length - 1] ?? "final stage";
    charts.push({
      title: hasRate ? `Conversion to ${last} by ${g.column}` : `Rows by ${g.column}`,
      type: "bar",
      labels: g.rows.map((r) => r.group),
      values: g.rows.map((r) => (hasRate ? (r.winRate ?? 0) : r.count)),
      unit: hasRate ? `Percent of leads reaching ${last}` : "Number of rows",
    });
  }
  if (analysis.trend && analysis.trend.rows.length > 1) {
    const useSum = analysis.valueColumn && analysis.trend.rows.some((r) => (r.sum ?? 0) > 0);
    charts.push({
      title: useSum ? `${analysis.valueColumn} by month` : "Rows by month",
      type: "line",
      labels: analysis.trend.rows.map((r) => r.period),
      values: analysis.trend.rows.map((r) => (useSum ? (r.sum ?? 0) : r.count)),
      unit: useSum ? `Total ${analysis.valueColumn}` : "Number of rows",
    });
  }
  return charts;
}
