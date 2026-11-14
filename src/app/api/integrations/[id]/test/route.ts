import { publish } from "@/lib/server/bus";
import { handle } from "@/lib/server/http";
import { testIntegration } from "@/lib/server/integrations";

export async function POST(_request: Request, ctx: RouteContext<"/api/integrations/[id]/test">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const result = await testIntegration(id);
    publish({ type: "integrations-changed" });
    return result;
  });
}
