// Deliverables the workforce saves: reports, charts, drafts and data extracts.
// Each one is a plain file in data/artifacts, with a row in the database that
// records who made it and for which plan and task.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact } from "@/lib/shared/types";
import { ARTIFACTS_DIR } from "./config";
import { getArtifactRow, saveArtifactRow } from "./db";

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "file";

export interface ArtifactInput {
  title: string;
  content: string;
  kind: Artifact["kind"];
  /** File extension without the dot: md, svg, csv, txt. */
  ext?: string;
  botId?: string;
  planId?: string;
  taskId?: string;
  conversationId?: string;
  simulated?: boolean;
}

export async function saveArtifact(input: ArtifactInput): Promise<Artifact> {
  const id = randomUUID().slice(0, 8);
  const ext = (input.ext ?? "md").replace(/[^a-z0-9]/gi, "") || "md";
  const file = `${new Date().toISOString().slice(0, 10)}-${slug(input.title)}-${id}.${ext}`;
  writeFileSync(join(ARTIFACTS_DIR, file), input.content);
  const artifact: Artifact = {
    id,
    title: input.title.slice(0, 160),
    file,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    botId: input.botId,
    planId: input.planId,
    taskId: input.taskId,
    conversationId: input.conversationId,
    bytes: Buffer.byteLength(input.content),
    simulated: input.simulated,
  };
  await saveArtifactRow(artifact);
  return artifact;
}

/** Where the browser can load an artifact file from. */
export function artifactUrl(file: string): string {
  return `/api/artifacts/file/${encodeURIComponent(file)}`;
}

const TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  eml: "text/plain; charset=utf-8",
};

/** Read one artifact file by name. The name is reduced to its last path segment, so it can't leave the folder. */
export function readArtifactFile(name: string): { content: Buffer; type: string } | null {
  const file = basename(name);
  const path = join(ARTIFACTS_DIR, file);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return { content: readFileSync(path), type: TYPES[ext] ?? "application/octet-stream" };
}

export async function artifactContent(id: string): Promise<{ artifact: Artifact; content: string } | null> {
  const artifact = await getArtifactRow(id);
  if (!artifact) return null;
  const file = readArtifactFile(artifact.file);
  return file ? { artifact, content: file.content.toString("utf8") } : null;
}
