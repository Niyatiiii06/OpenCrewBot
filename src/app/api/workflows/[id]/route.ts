import { body, handle } from "@/lib/server/http";
import { deleteWorkflow, parseSchedule, runWorkflow, updateWorkflow } from "@/lib/server/workflows";
import type { Workflow, WorkflowSchedule } from "@/lib/shared/types";

export async function PATCH(request: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const patch = await body<{ name?: string; instruction?: string; conversationId?: string; schedule?: WorkflowSchedule | string; status?: Workflow["status"] }>(request);
    const schedule = typeof patch.schedule === "string" ? parseSchedule(patch.schedule) : patch.schedule;
    return { workflow: await updateWorkflow(id, { ...patch, schedule }) };
  });
}

/** Run the workflow now. */
export async function POST(_request: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => ({ run: await runWorkflow(id, "manual") }));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  return handle(() => deleteWorkflow(id));
}
