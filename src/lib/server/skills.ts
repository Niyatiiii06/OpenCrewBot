// Skills: reusable playbooks any agent can pick up. A skill is one Markdown
// file, `skills/<id>/SKILL.md`, with a few header lines and the instructions.
// Built-in skills ship with the repository; skills you write in the app are
// saved under the data folder. Nothing here is code, so adding a skill never
// needs a source change.
//
// Agents see a one-line index of every skill in their prompt and load the full
// text of one with the `use_skill` tool. For planned tasks the engine picks the
// matching skills up front and puts their instructions in the task brief.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Skill } from "@/lib/shared/types";
import { CUSTOM_SKILLS_DIR } from "./config";
import { InputError } from "./errors";
import { publish } from "./bus";

const BUILT_IN_DIR = resolve(/*turbopackIgnore: true*/ process.cwd(), "skills");

function parse(raw: string, id: string, source: Skill["source"], path: string): Skill | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const list = (value?: string) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return {
    id,
    name: meta.name || id,
    description: meta.description || "",
    triggers: list(meta.triggers).map((t) => t.toLowerCase()),
    tools: list(meta.tools),
    output: meta.output || "",
    body: match[2].trim(),
    source,
    path,
  };
}

function readDir(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const skill = parse(readFileSync(path, "utf8"), entry.name, source, path);
    if (skill) out.push(skill);
  }
  return out;
}

/** Every skill, read from disk each time so an edit applies to the next task. A custom
 * skill with the same id as a built-in one replaces it. */
export function listSkills(): Skill[] {
  const byId = new Map<string, Skill>();
  for (const s of readDir(BUILT_IN_DIR, "built-in")) byId.set(s.id, s);
  for (const s of readDir(CUSTOM_SKILLS_DIR, "custom")) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(id: string): Skill | undefined {
  const wanted = id.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return listSkills().find((s) => s.id === wanted || s.name.toLowerCase() === id.trim().toLowerCase());
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export interface SkillInput {
  id?: string;
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  output: string;
  body: string;
}

/** Create or change a skill. Built-in skills are never overwritten: saving one writes
 * a custom copy with the same id, which then takes precedence. */
export function saveSkill(input: SkillInput): Skill {
  if (!input.name?.trim()) throw new InputError("A skill needs a name.");
  if (!input.body?.trim()) throw new InputError("A skill needs instructions.");
  const id = slug(input.id || input.name);
  if (!id) throw new InputError("That name can't be used for a skill.");
  const dir = join(CUSTOM_SKILLS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();
  const file = [
    "---",
    `name: ${oneLine(input.name)}`,
    `description: ${oneLine(input.description ?? "")}`,
    `triggers: ${(input.triggers ?? []).map(oneLine).filter(Boolean).join(", ")}`,
    `tools: ${(input.tools ?? []).map(oneLine).filter(Boolean).join(", ")}`,
    `output: ${oneLine(input.output ?? "")}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), file);
  publish({ type: "skills-changed" });
  return getSkill(id)!;
}

export function deleteSkill(id: string): void {
  const dir = join(CUSTOM_SKILLS_DIR, slug(id));
  if (!existsSync(dir)) throw new InputError("Only skills you created can be deleted. Built-in skills can be overridden by saving a copy.");
  rmSync(dir, { recursive: true, force: true });
  publish({ type: "skills-changed" });
}

/** How well a skill fits a piece of work: trigger words found in the text, with
 * multi-word triggers and name matches counting more. */
export function scoreSkill(skill: Skill, text: string): number {
  const lower = ` ${text.toLowerCase()} `;
  let score = 0;
  for (const trigger of skill.triggers) {
    if (!trigger) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (pattern.test(lower)) score += trigger.includes(" ") ? 3 : 1.5;
  }
  if (lower.includes(skill.name.toLowerCase())) score += 4;
  return score;
}

/** The skills that fit a task, best first. `pinned` are skills the agent always carries. */
export function selectSkills(text: string, pinned: string[] = [], max = 2): Skill[] {
  const all = listSkills();
  const ranked = all
    .map((skill) => ({ skill, score: scoreSkill(skill, text) }))
    .filter((r) => r.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((r) => r.skill);
  for (const id of pinned) {
    const skill = all.find((s) => s.id === id);
    if (skill && !ranked.includes(skill) && scoreSkill(skill, text) >= 1.5) ranked.push(skill);
  }
  return ranked.slice(0, max + 1);
}

/** One line per skill, for the agent's prompt. */
export function skillIndex(): string {
  return listSkills().map((s) => `- ${s.id}: ${s.description}`).join("\n");
}

export function skillBrief(skill: Skill): string {
  return [`### Skill: ${skill.name}`, skill.body, skill.output ? `Expected output: ${skill.output}` : ""].filter(Boolean).join("\n\n");
}
