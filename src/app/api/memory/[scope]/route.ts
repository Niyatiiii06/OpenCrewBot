import { listMemoryLog } from "@/lib/server/db";
import { body, handle } from "@/lib/server/http";
import { readScope, scopePath, writeScope } from "@/lib/server/memory-files";
import { InputError } from "@/lib/server/service";

function scopeOf(raw: string): string {
  const scope = decodeURIComponent(raw);
  try {
    scopePath(scope);
  } catch {
    throw new InputError("Unknown memory file.");
  }
  return scope;
}

export async function GET(_request: Request, ctx: RouteContext<"/api/memory/[scope]">) {
  const raw = (await ctx.params).scope;
  return handle(async () => {
    const scope = scopeOf(raw);
    return { scope, content: readScope(scope), path: scopePath(scope), log: await listMemoryLog(scope, 100) };
  });
}

/** Save an edit from the memory manager. Agents read the file again on their next turn. */
export async function PUT(request: Request, ctx: RouteContext<"/api/memory/[scope]">) {
  const raw = (await ctx.params).scope;
  return handle(async () => {
    const scope = scopeOf(raw);
    const { content, why } = await body<{ content: string; why?: string }>(request);
    if (typeof content !== "string") throw new InputError("Expected { content }.");
    if (content.length > 200_000) throw new InputError("Memory files are limited to 200,000 characters.");
    const saved = writeScope(scope, content, { by: "You", why: why?.trim() || "edited in the memory manager", source: "memory manager" });
    return { content: saved };
  });
}
