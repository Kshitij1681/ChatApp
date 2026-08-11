import { Router } from "express";
import { Conversation } from "../models/Conversation.js";
import { publicMessage } from "../models/Message.js";
import { User, publicUser } from "../models/User.js";
import { searchMessages, excerpt } from "../lib/search.js";
import { allowSearch } from "../lib/ratelimit.js";
import { requireAuth, requireUsername, wrap } from "../lib/guards.js";
import { asObjectId } from "../lib/ids.js";

const router = Router();
router.use(requireAuth, requireUsername);

/**
 * Search your own message history.
 *
 * The scope comes from the session user, inside searchMessages() — nothing in
 * the query string can widen it. `conversationId` may only narrow, and an id
 * you are not a participant in simply matches no conversations and returns
 * nothing, which is also why it needs no separate 403.
 */
router.get(
  "/",
  wrap(async (req, res) => {
    if (!allowSearch(req.user._id)) return res.status(429).json({ error: "rate_limited" });

    const q = String(req.query.q ?? "");
    if (req.query.before && !asObjectId(req.query.before)) {
      return res.status(400).json({ error: "bad_cursor" });
    }
    if (req.query.conversationId && !asObjectId(req.query.conversationId)) {
      return res.status(400).json({ error: "bad_cursor" });
    }
    const { messages, nextCursor, hasMore } = await searchMessages(req.user._id, {
      q,
      conversationId: req.query.conversationId,
      before: req.query.before,
      limit: req.query.limit,
    });

    if (!messages.length) return res.json({ results: [], nextCursor: null, hasMore: false });

    // One round trip for the conversations on this page, one for their peers —
    // rather than a populate per row.
    const convoIds = [...new Set(messages.map((m) => String(m.conversation)))];
    const convos = await Conversation.find({ _id: { $in: convoIds } }).lean();
    const byConvo = new Map(convos.map((c) => [String(c._id), c]));

    const peerIds = convos.map((c) => c.participants.find((p) => String(p) !== String(req.user._id)));
    const peers = await User.find({ _id: { $in: peerIds } }).lean();
    const byUser = new Map(peers.map((p) => [String(p._id), p]));

    const results = messages.map((m) => {
      const convo = byConvo.get(String(m.conversation));
      const peerId = convo?.participants.find((p) => String(p) !== String(req.user._id));
      const peer = byUser.get(String(peerId));
      return {
        message: publicMessage(m),
        // Plain text, never markup — the client renders it as a text node.
        excerpt: excerpt(m.body, q),
        conversationId: String(m.conversation),
        peer: peer ? publicUser(peer) : null,
        mine: String(m.from) === String(req.user._id),
      };
    });

    res.json({ results, nextCursor, hasMore });
  }),
);

export default router;
