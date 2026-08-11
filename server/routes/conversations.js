import { Router } from "express";
import { Conversation } from "../models/Conversation.js";
import { Message, publicMessage } from "../models/Message.js";
import { User, publicUser } from "../models/User.js";
import { requireAuth, requireUsername, wrap } from "../lib/guards.js";
import { asObjectId, clearedBound } from "../lib/ids.js";
import { tombstoneMessage, clearForMe, destroyForEveryone } from "../lib/deletion.js";
import { isOnline, sendTo } from "../ws/hub.js";

const router = Router();
router.use(requireAuth, requireUsername);

const PAGE = 40;
const MAX_PAGE = 100;

/**
 * Every message query in this file carries the caller's cleared bound.
 * "Delete for me" is only real if it holds on every read path — thread, search,
 * unread count, and sidebar preview alike.
 */
function clearedFilter(state) {
  const bound = clearedBound(state);
  return bound ? { _id: { $gt: bound } } : {};
}

router.get(
  "/",
  wrap(async (req, res) => {
    const me = String(req.user._id);
    const convos = await Conversation.find({
      participants: me,
      participantState: { $elemMatch: { user: me, hidden: { $ne: true } } },
    })
      .sort({ "lastMessage.at": -1, _id: -1 })
      .limit(100);

    const peerIds = convos.map((c) => c.otherThan(me));
    const peers = await User.find({ _id: { $in: peerIds } });
    const byId = new Map(peers.map((p) => [String(p._id), p]));

    const items = await Promise.all(
      convos.map(async (c) => {
        const state = c.stateFor(me);
        const peer = byId.get(String(c.otherThan(me)));
        const unread = await Message.countDocuments({
          conversation: c._id,
          from: { $ne: me },
          readAt: null,
          deletedForEveryone: false, // a tombstone must never count as unread
          ...clearedFilter(state),
        });
        return {
          id: String(c._id),
          peer: peer ? { ...publicUser(peer), online: isOnline(peer._id) } : null,
          lastMessage: c.lastMessage?.at ? c.lastMessage : null,
          unread,
          closedByPeer: !!state?.closedByPeer,
          updatedAt: c.updatedAt,
        };
      }),
    );

    res.json({ conversations: items });
  }),
);

/** Open (or create) the thread with one person. Addressed by username, not id. */
router.post(
  "/",
  wrap(async (req, res) => {
    const handle = String(req.body?.username ?? "").toLowerCase();
    const peer = await User.findOne({ username: handle, deleted: { $ne: true } });
    if (!peer) return res.status(404).json({ error: "no_such_user" });
    if (String(peer._id) === String(req.user._id)) return res.status(400).json({ error: "self" });

    const convo = await Conversation.between(req.user._id, peer._id);
    const state = convo.stateFor(req.user._id);
    // Opening a thread you'd hidden un-hides it for you, and only for you.
    if (state?.hidden) {
      await Conversation.updateOne(
        { _id: convo._id },
        { $set: { "participantState.$[me].hidden": false } },
        { arrayFilters: [{ "me.user": req.user._id }] },
      );
    }

    res.status(201).json({
      conversation: {
        id: String(convo._id),
        peer: { ...publicUser(peer), online: isOnline(peer._id) },
        lastMessage: convo.lastMessage?.at ? convo.lastMessage : null,
        unread: 0,
        closedByPeer: !!state?.closedByPeer,
      },
    });
  }),
);

/**
 * Newest-first page, walking backwards from a cursor.
 *
 * Cursor on `_id`, never skip/limit. `skip(n)` reads and discards n documents,
 * and it is outright wrong while messages are arriving: a new row shifts every
 * later page and the reader sees duplicates.
 *
 * `?at=<messageId>` instead returns a window centred on one message, which is
 * how a search result opens: the match plus enough either side to read it in
 * context. A window can have newer messages below it, so the response carries
 * `hasNewer` — without it the client would think it was at the live end of the
 * thread and quietly stop showing arrivals in order.
 */
router.get(
  "/:id/messages",
  wrap(async (req, res) => {
    const id = asObjectId(req.params.id);
    if (!id) return res.status(404).json({ error: "not_found" });

    const convo = await Conversation.findById(id);
    if (!convo || !convo.isParticipant(req.user._id)) return res.status(404).json({ error: "not_found" });

    const state = convo.stateFor(req.user._id);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || PAGE));
    const base = { conversation: convo._id, ...clearedFilter(state) };

    // A cursor is the client's own bookmark, so a malformed one is a bug on that
    // side rather than a missing resource — say which parameter was wrong instead
    // of letting it cast-throw into a 500.
    if (req.query.at) {
      const at = asObjectId(req.query.at);
      if (!at) return res.status(400).json({ error: "bad_cursor" });
      return res.json(await windowAround(base, at, limit));
    }

    const query = { ...base };
    if (req.query.before) {
      const before = asObjectId(req.query.before);
      if (!before) return res.status(400).json({ error: "bad_cursor" });
      // Both bounds can apply at once — `before` from the scroll, `$gt` from clearedAt.
      query._id = { ...(query._id ?? {}), $lt: before };
    }

    // limit+1 to learn whether another page exists without a second count query.
    const rows = await Message.find(query).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      messages: page.map(publicMessage).reverse(), // oldest-first for rendering
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
      hasMore,
      hasNewer: false,
    });
  }),
);

/**
 * Half a page either side of a target message.
 *
 * Two queries rather than one, because "older than X" and "X and newer" sort in
 * opposite directions. Merging them here keeps the {conversation, _id} index in
 * play for both halves; a single `$or` would not use it as cleanly.
 */
async function windowAround(base, at, limit) {
  const half = Math.max(1, Math.floor(limit / 2));

  const [older, newer] = await Promise.all([
    Message.find({ ...base, _id: { ...(base._id ?? {}), $lt: at } })
      .sort({ _id: -1 })
      .limit(half + 1),
    Message.find({ ...base, _id: { ...(base._id ?? {}), $gte: at } })
      .sort({ _id: 1 })
      .limit(half + 1),
  ]);

  // The target itself lives at the head of `newer`. If it isn't there the
  // message was deleted or falls before this reader's clearedAt, and the window
  // is simply the surrounding history — not an error.
  const hasMore = older.length > half;
  const hasNewer = newer.length > half;
  const olderPage = hasMore ? older.slice(0, half) : older;
  const newerPage = hasNewer ? newer.slice(0, half) : newer;

  const messages = [...olderPage.reverse(), ...newerPage];
  return {
    messages: messages.map(publicMessage),
    nextCursor: olderPage.length ? String(olderPage[0]._id) : null,
    hasMore,
    hasNewer,
  };
}

/**
 * Delete one message for everyone. No time limit — an explicit product choice.
 *
 * Only the sender can, and that rule is expressed as part of the query rather
 * than an `if` after the fetch: `from: req.user._id` means a message someone
 * else sent is simply not found, so this route can never confirm that a message
 * id exists in a thread you are not in.
 */
router.delete(
  "/:id/messages/:messageId",
  wrap(async (req, res) => {
    const convoId = asObjectId(req.params.id);
    const messageId = asObjectId(req.params.messageId);
    if (!convoId || !messageId) return res.status(404).json({ error: "not_found" });

    const convo = await Conversation.findById(convoId);
    if (!convo || !convo.isParticipant(req.user._id)) return res.status(404).json({ error: "not_found" });

    const message = await Message.findOne({
      _id: messageId,
      conversation: convo._id,
      from: req.user._id,
    });
    if (!message) return res.status(404).json({ error: "not_found" });
    // Deleting a tombstone is a no-op, not an error — two tabs racing the same
    // button should both end up somewhere sane.
    if (message.deletedForEveryone) return res.json({ ok: true, alreadyDeleted: true });

    const { lastMessage } = await tombstoneMessage(message, req.user._id);

    const frame = {
      type: "msg:deleted",
      conversationId: String(convo._id),
      messageId: String(message._id),
      lastMessage: lastMessage ?? null,
    };
    // Both sides, including the deleter's own other tabs.
    sendTo(String(req.user._id), frame);
    sendTo(String(convo.otherThan(req.user._id)), frame);

    res.json({ ok: true });
  }),
);

/**
 * Delete a conversation. `scope` decides how far it reaches.
 *
 * "me" clears your copy and tells nobody. "everyone" destroys both copies and
 * notifies the other person — the notice is what separates this from silent
 * data destruction on someone else's account.
 */
router.delete(
  "/:id",
  wrap(async (req, res) => {
    const convoId = asObjectId(req.params.id);
    if (!convoId) return res.status(404).json({ error: "not_found" });

    const convo = await Conversation.findById(convoId);
    if (!convo || !convo.isParticipant(req.user._id)) return res.status(404).json({ error: "not_found" });

    // Default to the reversible one. A missing or unrecognised scope must never
    // be read as "destroy everything for both of us".
    const scope = req.query.scope === "everyone" ? "everyone" : "me";

    if (scope === "me") {
      await clearForMe(convo, req.user._id);
      // Your own other tabs need to drop the thread too.
      sendTo(String(req.user._id), {
        type: "convo:cleared",
        conversationId: String(convo._id),
      });
      return res.json({ ok: true, scope });
    }

    const { peerId } = await destroyForEveryone(convo, req.user._id);

    sendTo(String(req.user._id), { type: "convo:cleared", conversationId: String(convo._id) });
    sendTo(peerId, {
      type: "convo:destroyed",
      conversationId: String(convo._id),
      by: publicUser(req.user),
    });

    res.json({ ok: true, scope });
  }),
);

/**
 * Dismiss the "they deleted this conversation" notice.
 *
 * The notice has to be acknowledged rather than auto-expiring, because it is the
 * only record the other person gets that their history went away. Dismissing
 * hides the row; writing to them again brings the thread back empty.
 */
router.post(
  "/:id/dismiss",
  wrap(async (req, res) => {
    const convoId = asObjectId(req.params.id);
    if (!convoId) return res.status(404).json({ error: "not_found" });

    const convo = await Conversation.findById(convoId);
    if (!convo || !convo.isParticipant(req.user._id)) return res.status(404).json({ error: "not_found" });

    await Conversation.updateOne(
      { _id: convo._id },
      { $set: { "participantState.$[me].closedByPeer": false, "participantState.$[me].hidden": true } },
      { arrayFilters: [{ "me.user": convo.participants.find((p) => String(p) === String(req.user._id)) }] },
    );

    sendTo(String(req.user._id), { type: "convo:cleared", conversationId: String(convo._id) });
    res.json({ ok: true });
  }),
);

export default router;
