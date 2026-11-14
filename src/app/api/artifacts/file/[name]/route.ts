import { readArtifactFile } from "@/lib/server/artifacts";

export async function GET(_request: Request, ctx: RouteContext<"/api/artifacts/file/[name]">) {
  const file = readArtifactFile(decodeURIComponent((await ctx.params).name));
  if (!file) return Response.json({ error: "No such file." }, { status: 404 });
  return new Response(new Uint8Array(file.content), {
    headers: { "Content-Type": file.type, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" },
  });
}
