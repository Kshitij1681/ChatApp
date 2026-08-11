/**
 * What may be uploaded, and what it counts as.
 *
 * An allowlist, never a blocklist: a blocklist is a promise to have thought of
 * every dangerous type in advance, which nobody can keep.
 */
import { LIMITS } from "../config.js";

const IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const VIDEO = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUDIO = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"]);

// image/svg+xml is deliberately absent and must stay absent. An SVG is a
// document: it can carry <script>, and served same-origin it would run with
// full access to the session. There is no sanitizer here worth trusting.
const DOCUMENT = new Set([
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** Maps a declared MIME to a message kind, or null if it isn't allowed at all. */
export function kindForMime(mime) {
  const type = String(mime ?? "").split(";")[0].trim().toLowerCase();
  if (IMAGE.has(type)) return "image";
  if (VIDEO.has(type)) return "video";
  if (AUDIO.has(type)) return "audio";
  if (DOCUMENT.has(type)) return "file";
  return null;
}

export function limitForKind(kind) {
  return LIMITS[kind] ?? LIMITS.file;
}

/**
 * The Content-Type we are willing to serve back. A browser sniffing its own
 * answer is how a "text file" becomes script, so downloads pin this exactly and
 * send X-Content-Type-Options: nosniff alongside it.
 */
export function safeContentType(mime) {
  return kindForMime(mime) ? String(mime).split(";")[0].trim().toLowerCase() : "application/octet-stream";
}

/**
 * Inline rendering is limited to media the browser treats as media. Everything
 * else downloads — an inline PDF or HTML-ish document is a same-origin script
 * vector, and a download is merely inconvenient by comparison.
 */
export function dispositionFor(kind) {
  return kind === "image" || kind === "video" || kind === "audio" ? "inline" : "attachment";
}
