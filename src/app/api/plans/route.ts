import { connection } from "next/server";
import { listPlans } from "@/lib/server/db";
import { handle } from "@/lib/server/http";

export async function GET() {
  await connection();
  return handle(async () => ({ plans: await listPlans(100) }));
}
