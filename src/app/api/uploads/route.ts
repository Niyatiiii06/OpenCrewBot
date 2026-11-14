import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connection } from "next/server";
import { UPLOADS_DIR } from "@/lib/server/config";
import { listDataFiles } from "@/lib/server/data-analysis";
import { body, handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/service";

export async function GET() {
  await connection();
  return handle(async () => ({ files: listDataFiles() }));
}

/** Save a CSV the person picked, so agents can analyse it. */
export async function POST(request: Request) {
  return handle(async () => {
    const { name, content } = await body<{ name: string; content: string }>(request);
    const safe = String(name ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    if (!/\.(csv|tsv|txt)$/i.test(safe)) throw new InputError("Upload a .csv file. (Save Excel sheets as CSV first.)");
    if (typeof content !== "string" || !content.trim()) throw new InputError("The file is empty.");
    if (content.length > 5_000_000) throw new InputError("Files are limited to 5 MB.");
    writeFileSync(join(UPLOADS_DIR, safe), content);
    return { files: listDataFiles() };
  });
}
