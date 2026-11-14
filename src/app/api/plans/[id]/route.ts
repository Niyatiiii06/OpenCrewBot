import { getPlan } from "@/lib/server/db";
import { cancelPlan, cancelTask, resumePlan, retryTask } from "@/lib/server/engine";
import { body, handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/service";

export async function GET(_request: Request, ctx: RouteContext<"/api/plans/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const plan = await getPlan(id);
    if (!plan) throw new InputError("That plan doesn't exist.");
    return { plan };
  });
}

/** Controls: cancel or resume the plan, cancel or retry one task. */
export async function POST(request: Request, ctx: RouteContext<"/api/plans/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const { action, taskId } = await body<{ action: string; taskId?: string }>(request);
    if (action === "cancel") return { plan: await cancelPlan(id) };
    if (action === "resume") return { plan: await resumePlan(id) };
    if (action === "cancel-task" && taskId) return { plan: await cancelTask(id, taskId) };
    if (action === "retry-task" && taskId) return { plan: await retryTask(id, taskId) };
    throw new InputError("Unknown action.");
  });
}
