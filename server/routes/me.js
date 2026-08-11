import { Router } from "express";
import passport from "passport";
import { User, publicUser, USERNAME_COOLDOWN_MS } from "../models/User.js";
import { ReservedUsername } from "../models/ReservedUsername.js";
import { normalizeUsername, sanitizeName } from "../lib/sanitize.js";
import { allowClaim } from "../lib/ratelimit.js";
import { requireAuth, wrap } from "../lib/guards.js";
import { deleteAccount } from "../lib/deletion.js";
import { sendTo, socketsFor } from "../ws/hub.js";

const router = Router();

/**
 * Which sign-in buttons the door should offer.
 *
 * A strategy is only registered when its credentials are present, so asking
 * passport is asking the same question `/auth/google` asks before answering
 * 503 — one source of truth rather than a second list to keep in sync. Without
 * this the door offers every provider and someone who configured GitHub alone
 * gets a Google button that dead-ends on an error page.
 *
 * Names only. Whether a provider is *configured* is not a secret; the client
 * ids are public by design and the secrets never leave the server.
 */
function availableProviders() {
  return ["google", "github"].filter((name) => Boolean(passport._strategy(name)));
}

/**
 * The client routes off this one response: no `user` means show the door,
 * `username === null` means show the claim screen. One source of truth.
 */
router.get("/me", (req, res) => {
  const providers = availableProviders();
  if (!req.user || req.user.deleted) return res.json({ user: null, providers });
  res.json({
    providers,
    user: {
      ...publicUser(req.user),
      email: req.user.email ?? null, // your own address, never anyone else's
      provider: req.user.provider,
      cooldownMs: req.user.cooldownRemaining(),
    },
  });
});

/**
 * Claim or change the handle.
 *
 * Three ways to be refused: the shape is wrong, someone holds it, or it is
 * parked in ReservedUsername. A change also has to clear the 30-day cooldown,
 * and it parks the old handle on the way out.
 */
router.post(
  "/me/username",
  requireAuth,
  wrap(async (req, res) => {
    if (!allowClaim(String(req.user._id))) return res.status(429).json({ error: "slow_down" });

    const next = normalizeUsername(req.body?.username);
    if (!next) return res.status(400).json({ error: "bad_username" });

    const current = req.user.username ?? null;
    if (next === current) return res.json({ user: publicUser(req.user), unchanged: true });

    if (current) {
      const remaining = req.user.cooldownRemaining();
      if (remaining > 0) {
        return res.status(429).json({
          error: "cooldown",
          retryAfterMs: remaining,
          days: Math.ceil(remaining / 86_400_000),
        });
      }
    }

    if (await ReservedUsername.isBlocked(next)) return res.status(409).json({ error: "reserved" });
    if (await User.exists({ username: next })) return res.status(409).json({ error: "taken" });

    req.user.username = next;
    if (current) req.user.usernameChangedAt = new Date();

    try {
      await req.user.save();
    } catch (err) {
      // Two people claiming the same handle in the same instant: the unique
      // index picks a winner and the loser is told it's taken.
      if (err?.code === 11000) return res.status(409).json({ error: "taken" });
      throw err;
    }

    if (current) {
      await ReservedUsername.updateOne(
        { username: current },
        {
          $set: {
            reason: "changed",
            formerUser: req.user._id,
            at: new Date(),
            until: new Date(Date.now() + USERNAME_COOLDOWN_MS),
          },
        },
        { upsert: true },
      );
    }

    res.json({ user: publicUser(req.user) });
  }),
);

/** Type-ahead availability check for the claim screen. Never leaks who holds it. */
router.get(
  "/me/username/available",
  requireAuth,
  wrap(async (req, res) => {
    const candidate = normalizeUsername(req.query?.u);
    if (!candidate) return res.json({ available: false, reason: "bad_username" });
    if (candidate === req.user.username) return res.json({ available: true, reason: "yours" });
    if (await ReservedUsername.isBlocked(candidate)) return res.json({ available: false, reason: "reserved" });
    if (await User.exists({ username: candidate })) return res.json({ available: false, reason: "taken" });
    res.json({ available: true, reason: null });
  }),
);

router.patch(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    if (typeof req.body?.displayName === "string") {
      req.user.displayName = sanitizeName(req.body.displayName);
      await req.user.save();
    }
    res.json({ user: publicUser(req.user) });
  }),
);

/**
 * Delete your account.
 *
 * Two gates before anything happens. You type your own handle — the one
 * confirmation that can't be produced by a mis-click or a cross-site POST — and
 * the destructive mode has to be named explicitly. `mode` defaults to
 * "anonymize" because a conversation is jointly authored: erasing your half
 * leaves holes in the other person's record of a conversation they were also
 * part of. Anyone who genuinely means "erase every message I sent" can say so.
 *
 * Everything after this point is irreversible, and the response says what went.
 */
router.delete(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    const typed = normalizeUsername(req.body?.confirmUsername);
    if (!req.user.username || typed !== req.user.username) {
      return res.status(400).json({ error: "confirm_username" });
    }

    const mode = req.body?.mode === "purge" ? "purge" : "anonymize";
    const result = await deleteAccount(req.user, { purge: mode === "purge" });

    // Tell everyone who shares a thread with them, so an open sidebar stops
    // showing a live handle for someone who no longer exists.
    for (const convo of result.conversations) {
      sendTo(convo.peerId, {
        type: "peer:deleted",
        conversationId: convo.id,
        userId: String(req.user._id),
        purged: result.purged,
      });
    }

    // Close their own sockets: the session rows are gone, but an open socket was
    // authorized at upgrade time and would otherwise outlive the account.
    for (const ws of [...socketsFor(req.user._id)]) ws.close(4001, "account_deleted");

    // The session cookie is destroyed last. Doing it earlier would leave the
    // request without the `req.user` the work above depends on. And it is
    // awaited — responding first would let the cookie linger for however long
    // the store takes to finish.
    await new Promise((resolve) => req.logout?.(() => resolve()));
    await new Promise((resolve) => req.session?.destroy?.(() => resolve()));
    res.clearCookie("chat.sid");

    res.json({ ok: true, mode, conversations: result.conversations.length });
  }),
);

export default router;
