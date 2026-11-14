import { connection } from "next/server";
import { listApprovals, listAudit } from "@/lib/server/db";
import { handle } from "@/lib/server/http";

export async function GET() {
  await connection();
  return handle(async () => ({ approvals: await listApprovals(200), audit: await listAudit(300) }));
}
