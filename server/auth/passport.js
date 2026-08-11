import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { User } from "../models/User.js";
import { sanitizeName, suggestUsername } from "../lib/sanitize.js";

passport.serializeUser((user, done) => done(null, String(user._id)));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    // A deleted account must not resolve to a live session.
    done(null, user && !user.deleted ? user : false);
  } catch (err) {
    done(err);
  }
});

/**
 * Upsert on (provider, providerId). Deliberately not on email: the same address
 * at Google and GitHub yields two accounts, which is the documented v1 tradeoff.
 */
async function upsert({ provider, providerId, displayName, email, avatarUrl }) {
  const existing = await User.findOne({ provider, providerId });
  if (existing) {
    // Keep the profile fresh, but never touch a username the user chose.
    existing.displayName = displayName;
    if (email) existing.email = email;
    if (avatarUrl) existing.avatarUrl = avatarUrl;
    await existing.save();
    return existing;
  }
  return User.create({ provider, providerId, displayName, email, avatarUrl });
}

export function configurePassport() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;

  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: GOOGLE_CLIENT_ID,
          clientSecret: GOOGLE_CLIENT_SECRET,
          callbackURL: "/auth/google/callback",
        },
        async (_at, _rt, profile, done) => {
          try {
            const user = await upsert({
              provider: "google",
              providerId: profile.id,
              displayName: sanitizeName(profile.displayName),
              email: profile.emails?.[0]?.value,
              avatarUrl: profile.photos?.[0]?.value,
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        },
      ),
    );
  } else {
    console.warn("[chat] Google OAuth not configured — /auth/google will 503");
  }

  if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          callbackURL: "/auth/github/callback",
          scope: ["user:email"],
        },
        async (_at, _rt, profile, done) => {
          try {
            const user = await upsert({
              provider: "github",
              providerId: String(profile.id),
              displayName: sanitizeName(profile.displayName || profile.username),
              email: profile.emails?.[0]?.value,
              avatarUrl: profile.photos?.[0]?.value,
            });
            // GitHub hands us a login we can offer as a starting point. It is a
            // suggestion for the claim screen, never an automatic assignment —
            // the handle is the user's to pick.
            //
            // It rides passport's `info` argument rather than the user document:
            // it isn't a schema field, so assigning it to the model would be
            // dropped silently by strict mode.
            const suggestedUsername = user.username ? "" : suggestUsername(profile.username ?? "");
            done(null, user, suggestedUsername ? { suggestedUsername } : undefined);
          } catch (err) {
            done(err);
          }
        },
      ),
    );
  } else {
    console.warn("[chat] GitHub OAuth not configured — /auth/github will 503");
  }

  return passport;
}

export { passport };
