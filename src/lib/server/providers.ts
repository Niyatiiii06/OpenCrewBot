// Model providers. The original app spoke only to Nebius Token Factory. This
// module lets any bot run on Groq, Google Gemini, Nebius, OpenRouter, OpenAI,
// Anthropic or a local Ollama server, and builds a fallback chain for when a
// provider fails or a model is retired.
//
// Model ids are Mastra model-router strings, "<provider>/<model>", for example
// "groq/openai/gpt-oss-120b". Mastra reads each provider's key from the
// environment variable named here, so no key ever sits in source code.
import { getProviderConfig } from "@mastra/core/llm";
import type { ModelOption, ProviderInfo } from "@/lib/shared/types";

export interface ProviderDef {
  id: string;
  name: string;
  envVar: string;
  /** Other variable names accepted for the same key. */
  aliases?: string[];
  keysUrl: string;
  /** A free tier exists that needs no card. */
  free: boolean;
  /** A server on this machine: no key, reachable only while it runs. */
  local?: boolean;
}

/** Free providers first: that is also the order used to pick a default model. */
export const PROVIDERS: ProviderDef[] = [
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", keysUrl: "https://console.groq.com/keys", free: true },
  {
    id: "google",
    name: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    aliases: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keysUrl: "https://aistudio.google.com/apikey",
    free: true,
  },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", keysUrl: "https://openrouter.ai/keys", free: true },
  { id: "nebius", name: "Nebius Token Factory", envVar: "NEBIUS_API_KEY", keysUrl: "https://tokenfactory.nebius.com", free: false },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys", free: false },
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", keysUrl: "https://console.anthropic.com", free: false },
  { id: "ollama", name: "Ollama (local)", envVar: "OLLAMA_BASE_URL", keysUrl: "https://ollama.com/download", free: true, local: true },
];

/** Accept GEMINI_API_KEY (the name Google's own docs use) for the Google provider. */
export function applyKeyAliases(): void {
  for (const p of PROVIDERS) {
    if (process.env[p.envVar]) continue;
    for (const alias of p.aliases ?? []) {
      if (process.env[alias]) {
        process.env[p.envVar] = process.env[alias];
        break;
      }
    }
  }
}
applyKeyAliases();

export function providerOf(modelId: string): string {
  return modelId.split("/")[0];
}

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providerConfigured(id: string): boolean {
  const def = providerDef(id);
  return Boolean(def && process.env[def.envVar]);
}

export function configuredProviders(): ProviderDef[] {
  return PROVIDERS.filter((p) => providerConfigured(p.id));
}

/** Bots saved by the original app stored a bare Nebius id ("MiniMaxAI/MiniMax-M3"). */
export function normalizeModelId(id: string): string {
  if (!id) return id;
  return PROVIDERS.some((p) => p.id === providerOf(id)) ? id : `nebius/${id}`;
}

// ── which models exist ──────────────────────────────────────────────────

const NOT_CHAT = /whisper|tts|embedding|guard|image|veo|lyria|orpheus|live|computer-use|deep-research|translate|allam|compound/i;

/** Models Mastra's registry (generated from models.dev) knows for a provider. */
function registryModels(provider: string): string[] {
  if (provider === "ollama") return ["llama3.1", "qwen3", "mistral"];
  try {
    const config = getProviderConfig(provider) as { models?: readonly string[] } | undefined;
    return [...(config?.models ?? [])].filter((m) => !NOT_CHAT.test(m));
  } catch {
    return [];
  }
}

const g = globalThis as unknown as { __opencrewbotLiveModels?: Map<string, { at: number; ids: string[] | null }> };
const liveCache = (g.__opencrewbotLiveModels ??= new Map());
const LIVE_TTL_MS = 10 * 60 * 1000;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Ask the provider which models this key can use right now. Null when it can't be asked. */
async function fetchLiveModels(provider: string): Promise<string[] | null> {
  const key = process.env[providerDef(provider)?.envVar ?? ""];
  if (!key) return null;
  try {
    if (provider === "groq") {
      const json = (await getJson("https://api.groq.com/openai/v1/models", { Authorization: `Bearer ${key}` })) as { data?: { id: string; active?: boolean }[] };
      return (json.data ?? []).filter((m) => m.active !== false).map((m) => m.id);
    }
    if (provider === "google") {
      const json = (await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { "x-goog-api-key": key })) as {
        models?: { name: string; supportedGenerationMethods?: string[] }[];
      };
      return (json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
    }
    if (provider === "openrouter") {
      const json = (await getJson("https://openrouter.ai/api/v1/models")) as { data?: { id: string }[] };
      return (json.data ?? []).map((m) => m.id);
    }
    if (provider === "nebius") {
      const json = (await getJson("https://api.tokenfactory.nebius.com/v1/models", { Authorization: `Bearer ${key}` })) as { data?: { id: string }[] };
      return (json.data ?? []).map((m) => m.id);
    }
    if (provider === "ollama") {
      const json = (await getJson(`${key.replace(/\/$/, "")}/api/tags`)) as { models?: { name: string }[] };
      return (json.models ?? []).map((m) => m.name.replace(/:latest$/, ""));
    }
  } catch {
    return null;
  }
  return null;
}

/** Chat models of one provider: the live list when the provider answers, else the registry. */
export async function providerModels(provider: string, fresh = false): Promise<{ ids: string[]; live: boolean }> {
  const cached = liveCache.get(provider);
  let live = cached && !fresh && Date.now() - cached.at < LIVE_TTL_MS ? cached.ids : undefined;
  if (live === undefined) {
    live = await fetchLiveModels(provider);
    liveCache.set(provider, { at: Date.now(), ids: live });
  }
  if (live?.length) return { ids: live.filter((m: string) => !NOT_CHAT.test(m)), live: true };
  return { ids: registryModels(provider), live: false };
}

// ── prices and capabilities ─────────────────────────────────────────────

/** List prices per million tokens, [input, output]. Free tiers bill nothing; the
 * figure shows what the same use would cost on a paid plan. Unknown models show no cost. */
const PRICES: [RegExp, number, number][] = [
  [/^groq\/openai\/gpt-oss-120b/, 0.15, 0.6],
  [/^groq\/openai\/gpt-oss-20b/, 0.075, 0.3],
  [/^groq\/llama-3\.3-70b/, 0.59, 0.79],
  [/^groq\/llama-3\.1-8b/, 0.05, 0.08],
  [/^groq\/qwen/, 0.29, 0.59],
  [/^google\/gemini-[\d.]+-flash-lite/, 0.1, 0.4],
  [/^google\/gemini-[\d.]+-flash/, 0.3, 2.5],
  [/^google\/gemini-flash-lite/, 0.1, 0.4],
  [/^google\/gemini-flash/, 0.3, 2.5],
  [/^google\/gemini-[\d.]+-pro/, 1.25, 10],
  [/^google\/gemma/, 0, 0],
  [/^nebius\/MiniMaxAI\/MiniMax-M3/, 0.3, 1.2],
  [/^nebius\/deepseek-ai\/DeepSeek-V4-Flash/, 0.14, 0.28],
  [/^nebius\/Qwen\/Qwen3-235B/, 0.2, 0.6],
  [/^nebius\/openai\/gpt-oss-120b/, 0.15, 0.6],
  [/^nebius\/nvidia\/Nemotron-3_5-Lightning/, 0.06, 0.24],
  [/^openai\/gpt-5-mini|^openai\/gpt-4\.1-mini/, 0.4, 1.6],
  [/^openai\/gpt-4o-mini/, 0.15, 0.6],
  [/^openai\/gpt-4\.1$/, 2, 8],
  [/^anthropic\/claude-haiku/, 1, 5],
  [/^anthropic\/claude-sonnet/, 3, 15],
  [/^anthropic\/claude-opus/, 5, 25],
  [/:free$/, 0, 0],
  [/^ollama\//, 0, 0],
];

export function priceOf(modelId: string): { inputPerM: number | null; outputPerM: number | null } {
  for (const [pattern, input, output] of PRICES) if (pattern.test(modelId)) return { inputPerM: input, outputPerM: output };
  return { inputPerM: null, outputPerM: null };
}

function label(id: string): string {
  const name = id.split("/").pop() ?? id;
  return name.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

export function optionFor(provider: string, model: string, live: boolean): ModelOption {
  const id = `${provider}/${model}`;
  const price = priceOf(id);
  return {
    id,
    label: label(model),
    provider,
    providerName: providerDef(provider)?.name ?? provider,
    available: providerConfigured(provider),
    context: /gemini/.test(model) ? 1_048_576 : 131_072,
    tools: !/gemma|8b/.test(model) || /8b-instant/.test(model),
    reasoning: /gpt-oss|qwen|gemini|deepseek|claude|MiniMax|glm/i.test(model),
    vision: /gemini|gpt-4|gpt-5|claude|vision|scout/i.test(model),
    ...price,
    live,
  };
}

// ── choosing a model ────────────────────────────────────────────────────

export type RoutingTier = "fast" | "balanced" | "strong";

/** Per provider, what counts as fast / balanced / strong, best match first. */
const TIER_PREFERENCES: Record<string, Record<RoutingTier, RegExp[]>> = {
  groq: {
    fast: [/gpt-oss-120b/, /llama-3\.3-70b/, /gpt-oss-20b$/, /llama-3\.1-8b-instant/],
    balanced: [/gpt-oss-120b/, /llama-3\.3-70b/, /qwen3\.8/],
    strong: [/gpt-oss-120b/, /qwen3\.8/, /llama-3\.3-70b/],
  },
  google: {
    fast: [/gemini-3\.5-flash-lite$/, /gemini-flash-lite-latest/, /flash-lite$/, /gemini-3\.5-flash$/],
    balanced: [/gemini-3\.5-flash$/, /gemini-3\.8-flash$/, /gemini-flash-latest/, /gemini-[\d.]+-flash$/],
    strong: [/gemini-3\.8-flash$/, /gemini-3\.7-flash$/, /gemini-3\.5-flash$/, /gemini-flash-latest/, /pro/],
  },
  openrouter: {
    fast: [/llama-3\.3-70b-instruct:free/, /:free$/],
    balanced: [/llama-3\.3-70b-instruct:free/, /:free$/],
    strong: [/qwen.*:free/, /:free$/],
  },
  nebius: {
    fast: [/Nemotron-3_5-Lightning/, /Qwen3-30B/, /gpt-oss-120b/],
    balanced: [/MiniMax-M3/, /gpt-oss-120b/, /Qwen3-235B/],
    strong: [/DeepSeek-V4-Pro/, /Qwen3\.5-397B/, /MiniMax-M3/],
  },
  openai: {
    fast: [/gpt-5-nano/, /gpt-4o-mini/, /mini/],
    balanced: [/gpt-5-mini/, /gpt-4\.1-mini/, /mini/],
    strong: [/gpt-5\.\d$/, /gpt-5$/, /gpt-4\.1$/],
  },
  anthropic: {
    fast: [/claude-haiku-4-5$/, /haiku/],
    balanced: [/claude-sonnet-4-5$/, /sonnet/, /haiku/],
    strong: [/claude-sonnet-4-5$/, /sonnet/, /opus/],
  },
  ollama: { fast: [/.*/], balanced: [/.*/], strong: [/qwen/, /.*/] },
};

async function pickForProvider(provider: string, tier: RoutingTier): Promise<string | null> {
  const { ids } = await providerModels(provider);
  for (const pattern of TIER_PREFERENCES[provider]?.[tier] ?? [/.*/]) {
    const match = ids.find((m) => pattern.test(m));
    if (match) return `${provider}/${match}`;
  }
  return ids[0] ? `${provider}/${ids[0]}` : null;
}

/** The best model for a tier on the first configured provider. Null in mock mode. */
export async function modelForTier(tier: RoutingTier): Promise<string | null> {
  const forced = process.env.OPENCREWBOT_DEFAULT_MODEL;
  if (forced && providerConfigured(providerOf(forced)) && tier !== "fast") return forced;
  for (const p of configuredProviders()) {
    const pick = await pickForProvider(p.id, tier);
    if (pick) return pick;
  }
  return null;
}

export async function defaultModelId(): Promise<string> {
  return (await modelForTier("balanced")) ?? "groq/openai/gpt-oss-120b";
}

/** Is this model one its provider still offers? Unknown providers are trusted. */
async function modelExists(modelId: string): Promise<boolean> {
  const provider = providerOf(modelId);
  const { ids, live } = await providerModels(provider);
  if (!live) return true;
  return ids.includes(modelId.slice(provider.length + 1));
}

/** Models to try for one piece of work, in order: the wanted model, the bot's own
 * fallbacks, then the same tier on every other configured provider. Providers
 * without a key and models the provider has retired are left out. */
export async function modelChain(primary: string | null, fallbacks: string[] = [], tier: RoutingTier = "balanced"): Promise<string[]> {
  const chain: string[] = [];
  const push = async (id: string | null | undefined) => {
    if (!id) return;
    const normal = normalizeModelId(id);
    if (chain.includes(normal) || !providerConfigured(providerOf(normal))) return;
    if (!(await modelExists(normal))) return;
    chain.push(normal);
  };
  await push(primary);
  for (const f of fallbacks) await push(f);
  for (const p of configuredProviders()) await push(await pickForProvider(p.id, tier));
  // A second, different model on each provider: rate limits are usually per model.
  for (const p of configuredProviders()) await push(await pickForProvider(p.id, tier === "fast" ? "balanced" : "fast"));
  // Still short (one provider, or a local server): add that provider's other chat models.
  for (const p of configuredProviders()) {
    if (chain.length >= 4) break;
    const { ids } = await providerModels(p.id);
    const known = Object.values(TIER_PREFERENCES[p.id] ?? {}).flat();
    for (const id of ids) {
      if (chain.length >= 4) break;
      if (p.local || known.some((pattern) => pattern.test(id))) await push(`${p.id}/${id}`);
    }
  }
  // Models that failed in the last two minutes go to the back of the line.
  const cooling = (id: string) => (failedAt.get(id) ?? 0) > Date.now() - 120_000;
  return [...chain.filter((id) => !cooling(id)), ...chain.filter(cooling)];
}

const failedAt = new Map<string, number>();

/** Remember that a model just failed, so the next turns try others first. */
export function markModelFailed(modelId: string): void {
  failedAt.set(modelId, Date.now());
}

/** What Mastra's model router needs for one id. Ollama runs on this machine behind an
 * OpenAI-compatible endpoint, so it is passed as a URL config instead of a name. */
export function routerConfig(modelId: string): string | { providerId: string; modelId: string; url: string; apiKey: string } {
  if (providerOf(modelId) === "ollama") {
    const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    return { providerId: "ollama", modelId: modelId.slice("ollama/".length), url: `${base}/v1`, apiKey: "ollama" };
  }
  return modelId;
}

/** Light work goes to a fast model, heavy reasoning to a strong one. */
export function tierForTask(text: string, kind: "plan" | "work" | "review" | "consolidate" | "chat" = "work"): RoutingTier {
  if (kind === "plan" || kind === "consolidate") return "strong";
  if (kind === "review") return "balanced";
  const heavy = /\b(analy[sz]e|strategy|strategic|compare|financial|model|architecture|review|recommend|plan|evaluate|research)\b/i.test(text);
  if (heavy || text.length > 600) return "balanced";
  return text.length < 160 ? "fast" : "balanced";
}

export async function providerInfos(): Promise<ProviderInfo[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => ({
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      keysUrl: p.keysUrl,
      free: p.free,
      local: Boolean(p.local),
      configured: providerConfigured(p.id),
      models: providerConfigured(p.id) ? (await providerModels(p.id)).ids.slice(0, 40) : registryModels(p.id).slice(0, 12),
    })),
  );
}
