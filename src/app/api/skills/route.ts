import { connection } from "next/server";
import { body, handle } from "@/lib/server/http";
import { toolCatalog } from "@/lib/server/native-tools";
import { InputError } from "@/lib/server/service";
import { listSkills, saveSkill, type SkillInput } from "@/lib/server/skills";

export async function GET() {
  await connection();
  return handle(async () => ({ skills: listSkills(), tools: await toolCatalog() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<SkillInput>(request);
    if (!input.name?.trim() || !input.body?.trim()) throw new InputError("A skill needs a name and instructions.");
    return { skill: saveSkill(input) };
  });
}
