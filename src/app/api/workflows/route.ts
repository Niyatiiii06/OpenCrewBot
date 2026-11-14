import { connection } from "next/server";
import { listWorkflowRuns, listWorkflows } from "@/lib/server/db";
import { body, handle } from "@/lib/server/http";
import { createWorkflow, describeSchedule, parseSchedule } from "@/lib/server/workflows";
import type { WorkflowSchedule } from "@/lib/shared/types";

export async function GET() {
  await connection();
  return handle(async () => ({
    workflows: (await listWorkflows()).map((w) => ({ ...w, scheduleText: describeSchedule(w.schedule) })),
    runs: await listWorkflowRuns(undefined, 100),
  }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<{ name: string; instruction: string; conversationId: string; schedule: WorkflowSchedule | string }>(request);
    const schedule = typeof input.schedule === "string" ? parseSchedule(input.schedule) : input.schedule;
    return { workflow: await createWorkflow({ ...input, schedule }) };
  });
}
