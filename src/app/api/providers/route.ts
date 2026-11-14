import { connection } from "next/server";
import { usageSummary } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { listModels } from "@/lib/server/models";
import { modelForTier, providerInfos } from "@/lib/server/providers";

export async function GET() {
  await connection();
  return handle(async () => ({
    providers: await providerInfos(),
    usage: await usageSummary(),
    models: await listModels(),
    routing: { fast: await modelForTier("fast"), balanced: await modelForTier("balanced"), strong: await modelForTier("strong") },
  }));
}
