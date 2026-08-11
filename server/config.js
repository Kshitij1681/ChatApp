import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, ".env") });

// 8000 matches client/vite.config.js's SERVER_PORT default. The two have to
// agree: the dev server proxies /api, /auth and /ws to that number, so a
// mismatch leaves every request in the browser hanging with nothing behind it.
export const PORT = Number(process.env.PORT ?? 8000);
export const IS_PROD = process.env.NODE_ENV === "production";
export const MONGODB_URI = process.env.MONGODB_URI ?? "";
export const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

export const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

/** Unset means allow any origin — right for local dev, wrong in production. */
export function originAllowed(origin) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

export const ALLOW_TEST_LOGIN = process.env.ALLOW_TEST_LOGIN === "1" && !IS_PROD;
export const TEST_LOGIN_SECRET = process.env.TEST_LOGIN_SECRET ?? "";

// Size ceilings. Atlas M0 gives 512 MB for everything — messages, indexes,
// sessions, and files — so these are deliberately tight. See README.
export const LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  upload: 25 * 1024 * 1024, // hard multer ceiling
  perUser: 50 * 1024 * 1024,
  global: 400 * 1024 * 1024, // kill switch → 507
  recordingMs: 60_000,
};

/**
 * Fail loud, fail early. A test-login backdoor reachable in production is a
 * total auth bypass, so this crashes the process rather than warning — a
 * warning in a log nobody reads is how that ships.
 */
export function assertSafeConfig() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_TEST_LOGIN === "1") {
    console.error("FATAL: ALLOW_TEST_LOGIN=1 with NODE_ENV=production. That is an auth bypass.");
    process.exit(1);
  }
  const missing = ["MONGODB_URI", "SESSION_SECRET"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: missing required env: ${missing.join(", ")}. Copy .env.example to server/.env.`);
    process.exit(1);
  }
  if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
    console.error("FATAL: ALLOWED_ORIGINS must be set in production, or any page can open a socket.");
    process.exit(1);
  }
}
