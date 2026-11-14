// The model picker's catalog, across every provider. The original listed only
// Nebius Token Factory; this now asks each configured provider which models the
// key can use (so a retired model never shows as selectable) and falls back to
// Mastra's built-in registry for providers that are not configured yet.
import type { ModelOption } from "@/lib/shared/types";
import { PROVIDERS, normalizeModelId, optionFor, priceOf, providerConfigured, providerModels, providerOf } from "./providers";

/** Stored on new bots; bots on "auto" routing pick a model per task instead. */
export const DEFAULT_MODEL = "groq/openai/gpt-oss-120b";

const g = globalThis as unknown as { __opencrewbotModels?: { at: number; options: ModelOption[] } };
const TTL_MS = 5 * 60 * 1000;

/** Every chat model, configured providers first. `fresh` skips the cache. */
export async function listModels(fresh = false): Promise<ModelOption[]> {
  const cached = g.__opencrewbotModels;
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.options;
  const options: ModelOption[] = [];
  for (const p of PROVIDERS) {
    const { ids, live } = await providerModels(p.id, fresh);
    const shown = providerConfigured(p.id) ? ids : ids.slice(0, 8);
    for (const id of shown) options.push(optionFor(p.id, id, live));
  }
  options.sort((a, b) => Number(b.available) - Number(a.available) || 0);
  g.__opencrewbotModels = { at: Date.now(), options };
  return options;
}

export async function findModel(id: string): Promise<ModelOption | undefined> {
  if (!id || id === "mock") return undefined;
  const normal = normalizeModelId(id);
  const known = (await listModels()).find((m) => m.id === normal);
  if (known) return known;
  const provider = providerOf(normal);
  return optionFor(provider, normal.slice(provider.length + 1), false);
}

export function costUsd(model: ModelOption | undefined, input: number, output: number): number | null {
  if (!model || model.inputPerM === null || model.outputPerM === null) return null;
  return (input * model.inputPerM + output * model.outputPerM) / 1e6;
}

/** Cost of a call by model id alone, 0 when the price is unknown. */
export function costOf(modelId: string, input: number, output: number): number {
  const { inputPerM, outputPerM } = priceOf(normalizeModelId(modelId));
  if (inputPerM === null || outputPerM === null) return 0;
  return (input * inputPerM + output * outputPerM) / 1e6;
}
