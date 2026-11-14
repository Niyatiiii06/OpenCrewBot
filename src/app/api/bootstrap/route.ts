import { connection } from "next/server";
import { appStatus } from "@/lib/server/config";
import { listBots, listPlans, listRooms, pendingApprovals } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { listModels } from "@/lib/server/models";
import { summaries } from "@/lib/server/service";
import { liveViews } from "@/lib/server/browserbase";

export async function GET() {
  await connection();
  return handle(async () => {
    const [bots, rooms, conversations, models, plans, pending] = await Promise.all([listBots(), listRooms(), summaries(), listModels(), listPlans(40), pendingApprovals()]);
    return { status: appStatus(), bots, rooms, conversations, models, liveViews: liveViews(), plans, pendingApprovals: pending.length };
  });
}
