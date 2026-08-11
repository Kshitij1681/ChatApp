/**
 * Route guards. Every one of these derives the actor from the session — nothing
 * downstream may read an id out of a request body.
 */

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });
  if (req.user.deleted) return res.status(401).json({ error: "account_deleted" });
  next();
}

/**
 * Most of the app is unusable before a handle exists — you can't be found, and
 * you can't address anyone. Gate on it once here instead of in every route.
 */
export function requireUsername(req, res, next) {
  if (!req.user?.username) return res.status(403).json({ error: "username_required" });
  next();
}

/** Wraps an async handler so a rejected promise reaches Express's error path. */
export function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
