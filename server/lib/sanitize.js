/** Text sanitizer, ported from screenshare-console/server/rooms.js. */
export function sanitizeText(raw) {
  // Newlines survive so multi-line pastes keep their shape.
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 4000);
}

export function sanitizeName(raw) {
  const clean = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 40);
  return clean || "Someone";
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Lowercases and trims, then validates. It deliberately does NOT strip invalid
 * characters: silently turning "Has Capitals" into "hascapitals" would hand
 * someone a handle they never typed. Only case and surrounding space are
 * forgiven; anything else is a rejection.
 *
 * Returns "" on invalid, with no fallback, so a caller that forgets to check
 * assigns nothing rather than something wrong.
 */
export function normalizeUsername(raw) {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase();
  return USERNAME_RE.test(clean) ? clean : "";
}

/**
 * For turning an OAuth profile's login into a *suggestion*. Stripping is right
 * here — the result is offered to the user, never assigned — which is why it is
 * a separate function from normalizeUsername().
 */
export function suggestUsername(raw) {
  const clean = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  return USERNAME_RE.test(clean) ? clean : "";
}

/**
 * Filenames land in a Content-Disposition header, so strip anything that could
 * break out of it — quotes, CR/LF, and path separators are all header-injection
 * or traversal vectors.
 */
export function sanitizeFilename(raw) {
  const clean = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/"]/g, "_")
    .trim()
    .slice(0, 120);
  return clean || "file";
}

/** Escapes the regex metacharacters in user input before it reaches a query. */
export function escapeRegex(raw) {
  return String(raw ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
