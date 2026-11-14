import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AppStatus } from "@/lib/shared/types";
import { configuredProviders } from "./providers";

// The data folder is chosen at runtime, so keep the bundler from tracing it.
export const DATA_DIR = resolve(/*turbopackIgnore: true*/ process.env.OPENCREWBOT_DATA_DIR || "./data");
export const WORKSPACES_DIR = resolve(DATA_DIR, "workspaces");
/** Shared Markdown memory: project, user preferences, decisions, history, and one file per room. */
export const MEMORY_DIR = resolve(DATA_DIR, "memory");
/** Deliverables the workforce saves: reports, charts, drafts. */
export const ARTIFACTS_DIR = resolve(DATA_DIR, "artifacts");
/** Files you give the workforce to work on, e.g. a sales spreadsheet. */
export const UPLOADS_DIR = resolve(DATA_DIR, "uploads");
/** Skills you write yourself. Built-in skills ship in the repository's `skills/` folder. */
export const CUSTOM_SKILLS_DIR = resolve(DATA_DIR, "skills");
/** Emails, Slack posts and Notion pages written here when the real service is not connected. */
export const OUTBOX_DIR = resolve(DATA_DIR, "outbox");
for (const dir of [WORKSPACES_DIR, MEMORY_DIR, resolve(MEMORY_DIR, "rooms"), ARTIFACTS_DIR, UPLOADS_DIR, CUSTOM_SKILLS_DIR, OUTBOX_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// The app was called CrewRoom before; carry an existing database over once.
const APP_DB_PATH = resolve(DATA_DIR, "opencrewbot.db");
const LEGACY_DB_PATH = resolve(DATA_DIR, "crewroom.db");
if (!existsSync(APP_DB_PATH) && existsSync(LEGACY_DB_PATH)) renameSync(LEGACY_DB_PATH, APP_DB_PATH);

export const APP_DB_URL = `file:${APP_DB_PATH}`;
export const MASTRA_DB_URL = `file:${resolve(DATA_DIR, "mastra.db")}`;

/** The single local owner every bot thread belongs to. */
export const OWNER_ID = "owner";

export const keys = {
  nebius: () => Boolean(process.env.NEBIUS_API_KEY),
  tavily: () => Boolean(process.env.TAVILY_API_KEY),
  jev: () => Boolean(process.env.TYPESAFE_API_KEY),
  browserbase: () => Boolean(process.env.BROWSERBASE_API_KEY),
  composio: () => Boolean(process.env.COMPOSIO_API_KEY),
};

/** With no model provider configured (or OPENCREWBOT_MOCK=1), bots run on a scripted
 * local model. Tools, memory, approvals and the task engine still run for real. */
export const isMock = () => process.env.OPENCREWBOT_MOCK === "1" || configuredProviders().length === 0;

export function appStatus(): AppStatus {
  return {
    mock: isMock(),
    keys: { nebius: keys.nebius(), tavily: keys.tavily(), jev: keys.jev(), browserbase: keys.browserbase(), composio: keys.composio() },
    dataDir: DATA_DIR,
    providers: configuredProviders().map((p) => p.id),
  };
}
