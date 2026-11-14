"use client";

import clsx from "clsx";
import { Brain, CalendarClock, Cpu, History, ListChecks, MoreHorizontal, PanelLeft, Pin, Plug, Plus, Search, Settings, ShieldCheck, Sparkles, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { timeLabel } from "@/lib/client/format";
import type { Bot, ConversationSummary, Room } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { BotAvatar, IconButton, Mascot, RoomAvatar } from "./ui";
import type { WorkspacePage } from "./Workspace";

type Row =
  | { kind: "room"; id: string; room: Room; summary?: ConversationSummary }
  | { kind: "bot"; id: string; bot: Bot; summary?: ConversationSummary };

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, onOutside]);
}

export function Menu({
  items,
  onClose,
  className,
}: {
  items: { label: string; onClick: () => void; danger?: boolean; icon?: React.ReactNode }[];
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);
  return (
    <div ref={ref} role="menu" className={clsx("absolute z-40 min-w-48 rounded-2xl bg-raised p-1.5 shadow-pop ring-1 ring-line-strong", className)}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
            item.onClick();
          }}
          className={clsx(
            "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-raised-2",
            item.danger ? "text-danger" : "text-ink",
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

function RowItem({ row }: { row: Row }) {
  const { state, open, setInspector, toast } = useApp();
  const [menu, setMenu] = useState(false);
  const conversationId = `${row.kind === "room" ? "room" : "dm"}:${row.id}`;
  const { page } = useApp();
  const active = state.active === conversationId && !page;
  const summary = row.summary;
  const running = summary?.running ?? [];
  const name = row.kind === "room" ? row.room.name : row.bot.name;
  const pinned = row.kind === "room" ? row.room.pinned : row.bot.pinned;
  const memberColors =
    row.kind === "room" ? row.room.memberIds.map((id) => state.bots.find((b) => b.id === id)?.color).filter((c): c is string => Boolean(c)) : [];

  const runningNames = running.map((id) => state.bots.find((b) => b.id === id)?.name).filter(Boolean);
  const preview = running.length
    ? row.kind === "room"
      ? `${runningNames.join(", ")} typing…`
      : "typing…"
    : summary?.lastMessage
      ? `${summary.lastMessage.author === "You" ? "You: " : row.kind === "room" ? `${summary.lastMessage.author}: ` : ""}${summary.lastMessage.text}`
      : row.kind === "room"
        ? `${row.room.memberIds.length} bots`
        : row.bot.title || row.bot.description;

  const togglePin = async () => {
    try {
      if (row.kind === "room") await api.updateRoom(row.id, { pinned: !pinned });
      else await api.updateBot(row.id, { pinned: !pinned });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't update.");
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${name}? ${row.kind === "bot" ? "Its chat and MEMORY.md are deleted too." : "The room's chat is deleted too."}`)) return;
    try {
      if (row.kind === "room") await api.deleteRoom(row.id);
      else await api.deleteBot(row.id);
      if (active) open(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete.");
    }
  };

  const openWith = (tab: "details" | "memory" | "settings") => {
    open(conversationId);
    setInspector({ open: true, tab });
  };

  const items =
    row.kind === "room"
      ? [
          { label: pinned ? "Unpin" : "Pin to top", onClick: togglePin },
          { label: "Room settings", onClick: () => openWith("settings") },
          { label: "Delete room", onClick: remove, danger: true },
        ]
      : [
          { label: pinned ? "Unpin" : "Pin to top", onClick: togglePin },
          { label: "Edit profile", onClick: () => openWith("details") },
          { label: "Memory", onClick: () => openWith("memory") },
          { label: "Delete bot", onClick: remove, danger: true },
        ];

  return (
    <li className="group relative">
      <button
        onClick={() => open(conversationId)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
          active ? "bg-active" : "hover:bg-hover",
        )}
      >
        {row.kind === "room" ? (
          <RoomAvatar colors={memberColors} size={42} busy={running.length > 0} />
        ) : (
          <BotAvatar bot={row.bot} size={42} busy={running.length > 0} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-medium text-ink">
              {name}
              {pinned && <Pin size={11} className="shrink-0 rotate-45 text-faint" aria-label="Pinned" />}
            </span>
            {summary?.lastMessage && !running.length && (
              <span className="shrink-0 text-[11.5px] text-faint transition-opacity group-hover:opacity-0">{timeLabel(summary.lastMessage.createdAt)}</span>
            )}
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className={clsx("truncate text-[13.5px]", running.length ? "text-ok" : "text-mute")}>{preview}</span>
            {!!summary?.unread && !active && (
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">
                {summary.unread}
              </span>
            )}
          </span>
        </span>
      </button>
      <IconButton
        label={`More for ${name}`}
        onClick={() => setMenu((m) => !m)}
        className="absolute top-2 right-2 h-7 w-7 bg-raised-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <MoreHorizontal size={15} />
      </IconButton>
      {menu && <Menu items={items} onClose={() => setMenu(false)} className="top-10 right-2" />}
    </li>
  );
}

const PAGES: { page: WorkspacePage; label: string; icon: React.ReactNode }[] = [
  { page: "tasks", label: "Tasks", icon: <ListChecks size={15} /> },
  { page: "approvals", label: "Approvals", icon: <ShieldCheck size={15} /> },
  { page: "memory", label: "Memory", icon: <Brain size={15} /> },
  { page: "skills", label: "Skills & tools", icon: <Wrench size={15} /> },
  { page: "integrations", label: "Integrations", icon: <Plug size={15} /> },
  { page: "models", label: "Models", icon: <Cpu size={15} /> },
  { page: "workflows", label: "Workflows", icon: <CalendarClock size={15} /> },
  { page: "history", label: "History", icon: <History size={15} /> },
];

/** The 2.0 workspace: task dashboard, approval centre, memory, skills, integrations, models, workflows, history. */
function WorkspaceNav() {
  const { state, page, setPage } = useApp();
  const running = Object.values(state.plans).filter((p) => p.status === "running" || p.status === "awaiting-approval").length;
  return (
    <div className="grid grid-cols-2 gap-1 px-3 pb-3">
      {PAGES.map((p) => (
        <button
          key={p.page}
          onClick={() => setPage(p.page)}
          aria-current={page === p.page ? "page" : undefined}
          className={clsx("flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors", page === p.page ? "bg-active text-ink" : "text-mute hover:bg-hover hover:text-ink")}
        >
          {p.icon}
          <span className="min-w-0 flex-1 truncate">{p.label}</span>
          {p.page === "approvals" && state.pendingApprovals > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warn px-1 text-[10.5px] font-semibold text-black">{state.pendingApprovals}</span>
          )}
          {p.page === "tasks" && running > 0 && <span className="h-2 w-2 rounded-full bg-accent" title={`${running} running`} />}
        </button>
      ))}
    </div>
  );
}

/** Bottom bar: which models are in use, and the way to settings and keys. */
function SidebarFooter() {
  const { state, setPanel, setPage } = useApp();
  const status = state.status;
  const providers = status?.providers ?? [];
  return (
    <div className="flex items-center gap-1 border-t border-line px-3 py-3">
      <button
        onClick={() => setPage("models")}
        className="flex h-10 min-w-0 shrink items-center gap-2 rounded-xl px-3 text-left ring-1 ring-line transition-colors hover:bg-hover hover:ring-line-strong"
        title="Model providers"
      >
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", status?.mock ? "bg-warn" : "bg-ok")} />
        <span className="truncate text-[12px] text-mute">{status?.mock ? "Mock mode · add a model key" : `Models: ${providers.join(", ")}`}</span>
      </button>
      <IconButton label="Connections (Composio and MCP)" onClick={() => setPanel({ kind: "connections" })} className="ml-auto">
        <Plug size={18} />
      </IconButton>
      <IconButton label="Settings" onClick={() => setPanel({ kind: "settings" })}>
        <Settings size={18} />
      </IconButton>
    </div>
  );
}

export function Sidebar() {
  const { state, setPanel, setSidebarOpen } = useApp();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Row[] = [
      ...state.bots.map((bot) => ({ kind: "bot" as const, id: bot.id, bot, summary: state.summaries[`dm:${bot.id}`] })),
      ...state.rooms.map((room) => ({ kind: "room" as const, id: room.id, room, summary: state.summaries[`room:${room.id}`] })),
    ];
    const matches = all.filter((r) => {
      if (!q) return true;
      const text = r.kind === "room" ? `${r.room.name} ${r.room.topic}` : `${r.bot.name} ${r.bot.title} ${r.bot.handle}`;
      return text.toLowerCase().includes(q);
    });
    const recency = (r: Row) => r.summary?.lastMessage?.createdAt ?? (r.kind === "room" ? r.room.createdAt : r.bot.createdAt);
    const isPinned = (r: Row) => (r.kind === "room" ? r.room.pinned : r.bot.pinned);
    return matches.sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || recency(b).localeCompare(recency(a)));
  }, [state.rooms, state.bots, state.summaries, query]);

  return (
    <nav aria-label="Bots and rooms" className="flex h-full w-full flex-col bg-side">
      <header className="flex h-16 shrink-0 items-center justify-end gap-1.5 px-3">
        <IconButton label="Hide sidebar" onClick={() => setSidebarOpen(false)} className="mr-auto hidden md:inline-flex">
          <PanelLeft size={18} />
        </IconButton>
        <IconButton
          label="Search"
          onClick={() => {
            setSearching((s) => !s);
            setQuery("");
          }}
          className={clsx("bg-raised", searching && "bg-raised-2 text-ink")}
        >
          <Search size={17} />
        </IconButton>
        <div className="relative">
          <IconButton label="New bot or room" onClick={() => setNewMenu((v) => !v)} className="bg-raised">
            <Plus size={19} />
          </IconButton>
          {newMenu && (
            <Menu
              className="top-11 right-0"
              onClose={() => setNewMenu(false)}
              items={[
                { label: "New agent", onClick: () => setPanel({ kind: "new-bot" }), icon: <Sparkles size={16} /> },
                { label: "New room", onClick: () => setPanel({ kind: "new-room" }), icon: <RoomAvatar colors={["#22c55e", "#f59e0b"]} size={18} /> },
              ]}
            />
          )}
        </div>
      </header>

      <div className="flex flex-col items-center pt-1 pb-5">
        <Mascot color="#f4f4f4" size={60} />
        <span className="mt-2 text-[14px] font-medium">OpenCrewBot 2.0</span>
        <span className="text-[11.5px] text-faint">Autonomous AI workforce</span>
      </div>

      <WorkspaceNav />

      {searching && (
        <div className="px-3 pb-2">
          <label className="flex h-10 items-center gap-2 rounded-full bg-raised px-3.5 ring-1 ring-line focus-within:ring-2 focus-within:ring-accent">
            <Search size={15} className="text-faint" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearching(false)}
              placeholder="Search"
              aria-label="Search bots and rooms"
              className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")} className="text-faint hover:text-ink">
                <X size={14} />
              </button>
            )}
          </label>
        </div>
      )}

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {!state.loaded && <p className="px-3 py-6 text-sm text-mute">Loading…</p>}
        {rows.map((row) => (
          <RowItem key={`${row.kind}:${row.id}`} row={row} />
        ))}
        {state.loaded && rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-mute">{query ? "Nothing matches." : "No bots yet. Press + to make one."}</p>
        )}
      </ul>

      <SidebarFooter />
    </nav>
  );
}
