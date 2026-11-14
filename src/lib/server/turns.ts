// What each running turn is doing. Tools are built once per bot, but a tool call
// needs to know which conversation, plan and task it belongs to. The runtime
// registers a context when a turn starts; tools look it up from the thread id
// Mastra passes to every tool call.
import type { ConversationId } from "@/lib/shared/types";

export interface TurnContext {
  conversationId: ConversationId;
  botId: string;
  planId?: string;
  taskId?: string;
  /** External actions this turn has run, for the Controlled-access limit. */
  actions: number;
  /** Aborts when the turn is stopped, cancelled or times out. */
  signal?: AbortSignal;
  /** Show or clear the approval buttons on a tool step in chat. */
  markAwaiting?: (toolCallId: string, waiting: boolean, preview?: string) => void;
  /** Called when the turn starts or stops waiting on the person. */
  onWaiting?: (waiting: boolean) => void;
}

const g = globalThis as unknown as { __opencrewbotTurns?: Map<string, TurnContext> };
const turns = (g.__opencrewbotTurns ??= new Map());

const key = (conversationId: ConversationId, botId: string) => `${conversationId}|${botId}`;

export function setTurn(context: TurnContext): void {
  turns.set(key(context.conversationId, context.botId), context);
}

export function clearTurn(conversationId: ConversationId, botId: string): void {
  turns.delete(key(conversationId, botId));
}

export function getTurn(conversationId: ConversationId, botId: string): TurnContext | undefined {
  return turns.get(key(conversationId, botId));
}

/** Thread ids are `<kind>:<id>:<botId>:<generation>`, e.g. `room:ab12:9f3c:0`. */
export function parseThreadId(threadId: string | undefined): { conversationId: ConversationId; botId: string } | null {
  const parts = (threadId ?? "").split(":");
  if (parts.length < 4) return null;
  return { conversationId: `${parts[0]}:${parts[1]}`, botId: parts[2] };
}

interface ToolCallInfo {
  agent?: { threadId?: string; toolCallId?: string };
  abortSignal?: AbortSignal;
}

/** The turn a tool call belongs to. Falls back to the bot's only running turn. */
export function turnOf(toolContext: unknown, botId: string): TurnContext & { toolCallId: string } {
  const info = (toolContext ?? {}) as ToolCallInfo;
  const parsed = parseThreadId(info.agent?.threadId);
  let turn = parsed ? getTurn(parsed.conversationId, parsed.botId) : undefined;
  if (!turn) {
    const mine = [...turns.values()].filter((t) => t.botId === botId);
    if (mine.length === 1) turn = mine[0];
  }
  const base: TurnContext = turn ?? { conversationId: parsed?.conversationId ?? `dm:${botId}`, botId, actions: 0 };
  return Object.assign(base, { toolCallId: info.agent?.toolCallId ?? "", signal: base.signal ?? info.abortSignal });
}
