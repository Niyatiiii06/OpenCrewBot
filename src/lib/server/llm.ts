// One-off model calls that are not chat turns: the Chief of Staff's planning,
// the agent factory's drafting, the final consolidation. Each call walks a
// fallback chain, logs its token use, and returns null in mock mode so the
// caller can use its built-in rule-based path instead.
import { randomUUID } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { isMock } from "./config";
import { addUsage } from "./db";
import { costOf } from "./models";
import { markModelFailed, modelChain, modelForTier, routerConfig, type RoutingTier } from "./providers";

export interface Completion {
  text: string;
  model: string;
  /** Models that failed before this one answered. */
  failed: { model: string; error: string }[];
}

interface CompleteOptions {
  system: string;
  prompt: string;
  tier?: RoutingTier;
  /** What the call is for, shown on the Models page. */
  purpose: string;
  botId?: string;
  planId?: string;
  /** Preferred model (e.g. the Chief of Staff's own), tried first. */
  model?: string | null;
  fallbacks?: string[];
}

export async function complete(options: CompleteOptions): Promise<Completion | null> {
  if (isMock()) return null;
  const tier = options.tier ?? "balanced";
  const chain = await modelChain(options.model ?? (await modelForTier(tier)), options.fallbacks ?? [], tier);
  const failed: Completion["failed"] = [];
  for (const model of chain) {
    try {
      const agent = new Agent({
        id: `oneoff-${randomUUID().slice(0, 8)}`,
        name: "OpenCrewBot planner",
        instructions: options.system,
        model: routerConfig(model) as never,
      });
      const result = await agent.generate(options.prompt, { abortSignal: AbortSignal.timeout(90_000) } as never);
      const usage = (await Promise.resolve(result.usage).catch(() => undefined)) as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number } | undefined;
      const input = usage?.inputTokens ?? usage?.promptTokens ?? 0;
      const output = usage?.outputTokens ?? usage?.completionTokens ?? 0;
      await addUsage({
        id: randomUUID(),
        at: new Date().toISOString(),
        botId: options.botId,
        model,
        input,
        output,
        costUsd: costOf(model, input, output),
        planId: options.planId,
        purpose: options.purpose,
      });
      const text = String(result.text ?? "").trim();
      if (!text) throw new Error("The model returned an empty answer.");
      return { text, model, failed };
    } catch (error) {
      markModelFailed(model);
      failed.push({ model, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return null;
}

/** Pull a JSON object out of a model's answer, tolerating code fences and stray prose. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
