import { createAgentFromDraft, draftAgent } from "@/lib/server/factory";
import { body, handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/service";
import type { BotInput } from "@/lib/shared/types";

/** `{ description }` returns a draft to review. `{ input, memorySeed }` creates the agent. */
export async function POST(request: Request) {
  return handle(async () => {
    const { description, input, memorySeed } = await body<{ description?: string; input?: BotInput; memorySeed?: string }>(request);
    if (input) return { bot: await createAgentFromDraft(input, memorySeed ?? "", "factory") };
    if (!description || description.trim().length < 10) throw new InputError("Describe the agent in a sentence or two.");
    return { draft: await draftAgent(description) };
  });
}
