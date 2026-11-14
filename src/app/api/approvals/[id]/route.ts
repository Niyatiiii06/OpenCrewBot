import { getApproval } from "@/lib/server/db";
import { body, handle } from "@/lib/server/http";
import { respondToApproval } from "@/lib/server/runtime";
import { InputError } from "@/lib/server/service";

/** Approve or reject from the approval centre. Same path as the buttons in chat. */
export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const { approve } = await body<{ approve: boolean }>(request);
    const approval = await getApproval(id);
    if (!approval) throw new InputError("That approval doesn't exist.");
    if (approval.status !== "pending") throw new InputError(`This request is already ${approval.status}.`);
    await respondToApproval(approval.conversationId, approval.botId, approval.toolCallId, Boolean(approve));
    return { ok: true };
  });
}
