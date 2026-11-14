import { handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/service";
import { deleteSkill, getSkill } from "@/lib/server/skills";

export async function DELETE(_request: Request, ctx: RouteContext<"/api/skills/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const skill = getSkill(id);
    if (!skill) throw new InputError("That skill doesn't exist.");
    if (skill.source === "built-in") throw new InputError("Built-in skills can't be deleted. Save a custom skill with the same id to override it.");
    deleteSkill(id);
  });
}
