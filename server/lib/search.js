import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { asObjectId, clearedBound } from "./ids.js";

/**
 * Message search, behind one function so swapping to Atlas Search later is a
 * one-file change.
 *
 * This uses Mongo's `$text` index, not a regex. A regex over `body` cannot use
 * an index and table-scans every message anyone has ever sent — fine for three
 * test users, a full collection scan per keystroke in production.
 *
 * The trade is real and worth stating: `$text` matches whole words (stemmed), so
 * "meet" finds "meeting" but "eeti" finds nothing. Substring search is what
 * Atlas Search exists for; this is the honest index-backed version of it.
 */

const PAGE = 30;
const MAX_PAGE = 60;

/**
 * The conversations this user may search, each with its own lower bound on `_id`.
 *
 * "Delete for me" is per-participant, so every conversation carries a different
 * bound and there is no single filter that covers them all. Building the bounds
 * here — from the same participantState the thread route reads — is what stops
 * cleared history from leaking back through the search box.
 */
async function searchableScope(userId, conversationId) {
  const filter = { participants: userId };
  if (conversationId) {
    // Fails closed. A conversationId this function cannot use must narrow the
    // scope to nothing, never quietly widen it back to every conversation.
    const only = asObjectId(conversationId);
    if (!only) return [];
    filter._id = only;
  }

  const convos = await Conversation.find(filter).select("participants participantState").lean();

  return convos.map((c) => {
    const state = (c.participantState ?? []).find((s) => String(s.user) === String(userId));
    return { id: c._id, bound: clearedBound(state) };
  });
}

/**
 * One `$or` branch per conversation, so each carries its own cleared bound —
 * the id of the newest message that existed when that person cleared. lib/ids.js
 * explains why the bound is an id and not a timestamp.
 */
function scopeClause(scope) {
  const open = scope.filter((s) => !s.bound).map((s) => s.id);
  const bounded = scope.filter((s) => s.bound);

  const branches = bounded.map((s) => ({
    conversation: s.id,
    _id: { $gt: s.bound },
  }));
  if (open.length) branches.push({ conversation: { $in: open } });

  return branches;
}

/**
 * Searches the caller's own messages. Never call this with a `userId` taken from
 * a request body — the scope query is the entire authorization check here, and
 * it only holds if the id came from the session.
 *
 * Returns `{ messages, nextCursor, hasMore }`, newest first.
 */
export async function searchMessages(userId, { q, conversationId, before, limit } = {}) {
  const term = String(q ?? "").trim().slice(0, 120);
  if (term.length < 2) return { messages: [], nextCursor: null, hasMore: false };

  const scope = await searchableScope(userId, conversationId);
  if (!scope.length) return { messages: [], nextCursor: null, hasMore: false };

  const branches = scopeClause(scope);
  const size = Math.min(MAX_PAGE, Math.max(1, Number(limit) || PAGE));

  const query = {
    $text: { $search: term },
    // A tombstone has no body to match, but excluding it explicitly means a
    // stale index entry can never resurrect deleted text.
    deletedForEveryone: false,
    $and: [{ $or: branches }],
  };
  // Paging a search means the same cursor rule as the thread: walk `_id`
  // backwards. Offsets would duplicate rows as new messages arrive.
  const cursor = before ? asObjectId(before) : null;
  if (cursor) query.$and.push({ _id: { $lt: cursor } });

  const rows = await Message.find(query)
    // Newest-first, not by relevance score. In a chat, "when" is the thing you
    // are actually navigating by, and sorting on score would make the cursor
    // meaningless.
    .sort({ _id: -1 })
    .limit(size + 1)
    .lean();

  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;

  return {
    messages: page,
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    hasMore,
  };
}

/**
 * A one-line excerpt centred on the first match, for the result list.
 *
 * Deliberately not highlighted with markup — the client renders this as a text
 * node, and handing it HTML would be handing every sender an XSS primitive.
 * The client can find the term itself; the server's job is to trim.
 */
export function excerpt(body, term, width = 140) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;

  const word = String(term ?? "").trim().split(/\s+/)[0] ?? "";
  const at = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return `${text.slice(0, width)}…`;

  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = text.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${slice}${start + width < text.length ? "…" : ""}`;
}
