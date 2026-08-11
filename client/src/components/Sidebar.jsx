import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { stampOf } from "../lib/format.js";
import Avatar from "./Avatar.jsx";

export default function Sidebar({
  me,
  status,
  conversations,
  activeId,
  onOpen,
  onStart,
  onJump,
  onSignOut,
  onOpenSettings,
  onDismiss,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null); // { people, messages } | null
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  /**
   * One box, two indexes: the user directory and your own message history. They
   * are separate queries because they are separate questions — "who is this
   * person" and "where did we say that" — and running both means neither
   * requires knowing which mode to be in first.
   */
  useEffect(() => {
    const term = query.trim().replace(/^@/, "");
    if (term.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      // Settled, not all: a failed message search shouldn't blank the people
      // results that did come back.
      const [people, messages] = await Promise.allSettled([
        api.searchUsers(term),
        api.searchMessages(term, { limit: 20 }),
      ]);
      setResults({
        people: people.status === "fulfilled" ? people.value.users : [],
        messages: messages.status === "fulfilled" ? messages.value.results : [],
      });
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function clear() {
    setQuery("");
    setResults(null);
    setError(null);
  }

  async function start(username) {
    setError(null);
    try {
      await onStart(username);
      clear();
    } catch (err) {
      setError(err.code === "no_such_user" ? "No one holds that handle." : "Couldn't open that conversation.");
    }
  }

  async function jump(result) {
    await onJump(result.conversationId, result.message.id);
    clear();
  }

  return (
    <aside className="flex w-[19rem] shrink-0 flex-col border-r border-line bg-surface max-md:w-[15rem]">
      <header className="border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-lg font-semibold tracking-tight">Aerogramme</span>
          <ConnectionDot status={status} />
        </div>

        <div className="relative mt-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && clear()}
            placeholder="Search handles and messages"
            spellCheck={false}
            autoCapitalize="none"
            className="data w-full rounded-sm border border-line bg-raised px-3 py-2 outline-none placeholder:text-faint focus:border-wire"
          />
          {query ? (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear search"
              className="absolute inset-y-0 right-2 text-faint hover:text-ink"
            >
              ×
            </button>
          ) : null}
        </div>
        {error ? <p className="data mt-2 text-post">{error}</p> : null}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {results ? (
          <SearchResults results={results} searching={searching} term={query.trim()} onPick={start} onJump={jump} />
        ) : conversations.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-soft">
            No conversations yet. Search a handle above to start one.
          </p>
        ) : (
          <ul>
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                me={me}
                active={c.id === activeId}
                onOpen={() => onOpen(c.id)}
                onDismiss={() => onDismiss(c.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <Footer me={me} onSignOut={onSignOut} onOpenSettings={onOpenSettings} />
    </aside>
  );
}

function SearchResults({ results, searching, term, onPick, onJump }) {
  const { people, messages } = results;
  if (searching && !people.length && !messages.length) return <p className="eyebrow px-4 py-4">Searching</p>;
  if (!people.length && !messages.length) {
    return (
      <div className="px-4 py-6">
        <p className="text-sm text-ink-soft">Nothing for “{term}”.</p>
        {/* The index matches whole words, and saying so beats letting someone
            conclude their own history is missing. */}
        <p className="data mt-1 text-faint">Message search matches whole words.</p>
      </div>
    );
  }

  return (
    <>
      {people.length ? (
        <ul>
          <li className="eyebrow px-4 pt-4 pb-1.5">People</li>
          {people.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => onPick(u.username)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised"
              >
                <Avatar user={u} size={34} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{u.displayName}</span>
                  <span className="data block truncate text-faint">@{u.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {messages.length ? (
        <ul className={people.length ? "mt-1 border-t border-line" : ""}>
          <li className="eyebrow px-4 pt-4 pb-1.5">Messages</li>
          {messages.map((r) => (
            <li key={r.message.id}>
              <button
                type="button"
                onClick={() => onJump(r)}
                className="w-full border-l-2 border-transparent px-4 py-2.5 text-left hover:border-wire hover:bg-raised"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {r.mine ? "You" : (r.peer?.displayName ?? "Unknown")}
                    {r.mine && r.peer ? (
                      <span className="font-normal text-faint"> → @{r.peer.username}</span>
                    ) : null}
                  </span>
                  <span className="data shrink-0 text-faint">{stampOf(r.message.at)}</span>
                </span>
                {/* Rendered as a text node. The server sends plain text for
                    exactly this reason — highlighting is the client's job. */}
                <span className="mt-0.5 line-clamp-2 block text-sm text-ink-soft">
                  <Marked text={r.excerpt} term={term} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Highlights the search term inside an excerpt by splitting on it — never by
 * injecting markup. The needle is escaped before it reaches the RegExp, because
 * a search for "c++" would otherwise be a syntax error, and worse ones exist.
 */
function Marked({ text, term }) {
  const word = term.replace(/^@/, "").trim().split(/\s+/)[0] ?? "";
  if (!word) return text;
  const parts = String(text).split(new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-post/15 text-ink">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function ConversationRow({ conversation, me, active, onOpen, onDismiss }) {
  const { peer, lastMessage, unread, closedByPeer } = conversation;
  const mine = lastMessage?.from === me.id;

  return (
    <li
      className={`group relative flex items-center border-l-2 transition-colors ${
        active ? "border-post bg-raised" : "border-transparent hover:bg-raised/60"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
      >
        <Avatar user={peer} size={38} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{peer?.displayName ?? "Unknown"}</span>
            <span className="data shrink-0 text-faint">{stampOf(lastMessage?.at)}</span>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${unread ? "text-ink" : "text-ink-soft"}`}>
              {closedByPeer ? (
                <span className="text-faint italic">Deleted by {peer?.displayName ?? "them"}</span>
              ) : lastMessage ? (
                <>
                  {mine ? <span className="text-faint">You: </span> : null}
                  {lastMessage.deleted ? <span className="italic text-faint">Message deleted</span> : lastMessage.preview}
                </>
              ) : (
                <span className="text-faint">No messages yet</span>
              )}
            </span>
            {unread > 0 ? (
              <span className="data grid min-w-5 shrink-0 place-items-center rounded-full bg-post px-1.5 text-[11px] font-medium text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </span>
        </span>
      </button>

      {/* A sibling, not a child — a button inside a button is invalid, and the
          browser resolves it by dropping one of them. */}
      {closedByPeer ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss the closed conversation with ${peer?.displayName ?? "them"}`}
          title="Dismiss"
          className="mr-2 grid size-7 shrink-0 place-items-center rounded-full text-faint opacity-0 hover:bg-surface hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

function ConnectionDot({ status }) {
  const label =
    status === "open"
      ? "Connected"
      : status === "unauthorized"
        ? "Signed out"
        : status === "closed"
          ? "Reconnecting"
          : "Connecting";
  const tone = status === "open" ? "bg-live" : status === "unauthorized" ? "bg-post" : "bg-faint";

  return (
    <span className="flex items-center gap-1.5" title={label}>
      <span className={`size-1.5 rounded-full ${tone}`} />
      <span className="eyebrow">{label}</span>
    </span>
  );
}

function Footer({ me, onSignOut, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative border-t border-line px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <Avatar user={me} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.displayName}</span>
          <span className="data block truncate text-faint">@{me.username}</span>
        </span>
      </button>

      {open ? (
        <div className="absolute inset-x-3 bottom-full mb-1 overflow-hidden rounded-sm border border-line bg-raised shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-surface"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="block w-full border-t border-line px-3 py-2 text-left text-sm hover:bg-surface"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
