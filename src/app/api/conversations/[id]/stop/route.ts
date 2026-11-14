import { conversationParam, handle } from "@/lib/server/http";
import { stopEverything } from "@/lib/server/service";

export async function POST(_request: Request, ctx: RouteContext<"/api/conversations/[id]/stop">) {
  const id = conversationParam((await ctx.params).id);
  return handle(() => stopEverything(id));
}
