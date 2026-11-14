import { connection } from "next/server";
import { publish } from "@/lib/server/bus";
import { body, handle } from "@/lib/server/http";
import { integrationFieldKeys, listIntegrations } from "@/lib/server/integrations";
import { addServer, listServers } from "@/lib/server/mcp-servers";
import { setSecret } from "@/lib/server/secrets";
import { InputError } from "@/lib/server/service";

export async function GET() {
  await connection();
  return handle(async () => ({ integrations: await listIntegrations() }));
}

/** Save credentials (stored encrypted, never sent back), or add the free DeepWiki MCP server. */
export async function POST(request: Request) {
  return handle(async () => {
    const { id, values, preset } = await body<{ id: string; values?: Record<string, string>; preset?: string }>(request);
    if (id === "mcp" && preset === "deepwiki") {
      const url = "https://mcp.deepwiki.com/mcp";
      if (!(await listServers()).some((s) => s.url === url)) await addServer({ name: "DeepWiki", url });
      publish({ type: "connections-changed" });
    } else {
      const allowed = integrationFieldKeys(id);
      if (!allowed.length) throw new InputError("This integration has no settings to save.");
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!allowed.includes(key)) throw new InputError(`Unknown field ${key}.`);
        if (typeof value === "string" && value.trim()) await setSecret(key, value.trim());
      }
    }
    publish({ type: "integrations-changed" });
    return { integrations: await listIntegrations() };
  });
}
