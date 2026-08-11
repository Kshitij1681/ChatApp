import session from "express-session";
import MongoStore from "connect-mongo";
import { IS_PROD, MONGODB_URI, SESSION_SECRET } from "../config.js";

/**
 * One session middleware for the whole process, built on first use.
 *
 * Lazy on purpose. ESM evaluates every import before any module body runs, so a
 * middleware constructed at import time would connect to Mongo before
 * assertSafeConfig() got a chance to speak — and a missing MONGODB_URI would
 * surface as a connect-mongo stack trace instead of the message that tells you
 * to copy .env.example.
 *
 * It is a singleton because the WebSocket upgrade handler runs this exact
 * instance over the raw request. Two instances would be two sources of truth
 * about who someone is.
 */
let instance = null;

export function getSessionMiddleware() {
  if (instance) return instance;

  instance = session({
    name: "chat.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      collectionName: "sessions",
      ttl: 14 * 24 * 60 * 60,
    }),
    cookie: {
      httpOnly: true, // no script can read it, so XSS can't lift the session
      sameSite: "lax", // survives the OAuth redirect back; blocks cross-site POSTs
      secure: IS_PROD,
      maxAge: 14 * 24 * 60 * 60 * 1000,
    },
  });

  return instance;
}
