import { Router } from "express";
import { User, publicUser } from "../models/User.js";
import { escapeRegex } from "../lib/sanitize.js";
import { requireAuth, requireUsername, wrap } from "../lib/guards.js";
import { isOnline } from "../ws/hub.js";

const router = Router();
router.use(requireAuth, requireUsername);

/**
 * Directory search over username and display name.
 *
 * Emails are not searchable and not returned — publicUser() has no email field,
 * so there is no way to harvest addresses out of this endpoint. Matching on
 * email would also turn the directory into a "does this person have an account"
 * oracle for any address you can guess.
 */
router.get(
  "/search",
  wrap(async (req, res) => {
    const raw = String(req.query.q ?? "").trim();
    if (raw.length < 2) return res.json({ users: [] });

    const needle = escapeRegex(raw.replace(/^@/, "").slice(0, 40));
    const prefix = new RegExp(`^${needle}`, "i");
    const anywhere = new RegExp(needle, "i");

    const rows = await User.find({
      _id: { $ne: req.user._id },
      deleted: { $ne: true },
      username: { $exists: true, $ne: null },
      $or: [{ username: prefix }, { displayName: anywhere }],
    })
      .limit(20)
      .lean();

    // Exact handle first, then prefix hits, then the rest.
    const scored = rows
      .map((u) => ({
        u,
        rank: u.username === needle.toLowerCase() ? 0 : prefix.test(u.username ?? "") ? 1 : 2,
      }))
      .sort((a, b) => a.rank - b.rank || (a.u.username ?? "").localeCompare(b.u.username ?? ""));

    res.json({
      users: scored.map(({ u }) => ({ ...publicUser(u), online: isOnline(u._id) })),
    });
  }),
);

router.get(
  "/:username",
  wrap(async (req, res) => {
    const handle = String(req.params.username).toLowerCase().replace(/^@/, "");
    const user = await User.findOne({ username: handle });
    if (!user) return res.status(404).json({ error: "no_such_user" });
    res.json({ user: { ...publicUser(user), online: isOnline(user._id) } });
  }),
);

export default router;
