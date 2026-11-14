import { connection } from "next/server";
import { artifactUrl } from "@/lib/server/artifacts";
import { listArtifacts } from "@/lib/server/db";
import { handle } from "@/lib/server/http";

export async function GET() {
  await connection();
  return handle(async () => ({ artifacts: (await listArtifacts(200)).map((a) => ({ ...a, url: artifactUrl(a.file) })) }));
}
