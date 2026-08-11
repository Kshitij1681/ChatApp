import { Router } from "express";
import passport from "passport";
import { ALLOW_TEST_LOGIN, CLIENT_ORIGIN, TEST_LOGIN_SECRET } from "../config.js";
import { User } from "../models/User.js";
import { sanitizeName } from "../lib/sanitize.js";

const router = Router();

/** Providers are only mounted when their credentials exist. */
function mountProvider(name, scope) {
  router.get(`/${name}`, (req, res, next) => {
    if (!passport._strategy(name)) {
      return res.status(503).json({ error: `${name}_not_configured` });
    }
    passport.authenticate(name, { scope })(req, res, next);
  });

  router.get(`/${name}/callback`, (req, res, next) => {
    passport.authenticate(name, { failureRedirect: `${CLIENT_ORIGIN}/?error=denied` }, (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.redirect(`${CLIENT_ORIGIN}/?error=denied`);
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        // The claim screen is the client's call — it reads GET /api/me and
        // routes on `username === null`, so there is one place that decides.
        const suggested = info?.suggestedUsername
          ? `&suggest=${encodeURIComponent(info.suggestedUsername)}`
          : "";
        res.redirect(`${CLIENT_ORIGIN}/?signedin=1${suggested}`);
      });
    })(req, res, next);
  });
}

mountProvider("google", ["profile", "email"]);
mountProvider("github", ["user:email"]);

router.post("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("chat.sid");
      res.json({ ok: true });
    });
  });
});

/**
 * Test-only sign-in. Real OAuth can't be driven from an automated suite, so the
 * suites use this instead.
 *
 * Three locks: the ALLOW_TEST_LOGIN flag, a NODE_ENV check folded into that flag
 * in config.js, and a shared secret. On top of those, assertSafeConfig() refuses
 * to boot the process at all if the flag is set with NODE_ENV=production — a
 * warning would not be enough, because this route is a total auth bypass.
 */
if (ALLOW_TEST_LOGIN) {
  console.warn("[chat] POST /auth/test-login is MOUNTED. Development only.");

  router.post("/test-login", async (req, res, next) => {
    try {
      if (!TEST_LOGIN_SECRET || req.get("x-test-secret") !== TEST_LOGIN_SECRET) {
        return res.status(403).json({ error: "forbidden" });
      }
      const handle = String(req.body?.username ?? "").toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) return res.status(400).json({ error: "bad_username" });

      const user = await User.findOneAndUpdate(
        { provider: "test", providerId: handle },
        {
          $setOnInsert: {
            provider: "test",
            providerId: handle,
            username: handle,
            displayName: sanitizeName(req.body?.displayName || handle),
            email: `${handle}@test.invalid`,
          },
        },
        { upsert: true, new: true },
      );

      req.login(user, (err) => (err ? next(err) : res.json({ ok: true, id: String(user._id) })));
    } catch (err) {
      next(err);
    }
  });
}

export default router;
