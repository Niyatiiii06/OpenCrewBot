import { connection } from "next/server";
import { listBots, listMemoryLog, listRooms } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { listScopes } from "@/lib/server/memory-files";

export async function GET() {
  await connection();
  return handle(async () => ({ scopes: listScopes(await listBots(), await listRooms()), log: await listMemoryLog(undefined, 100) }));
}
