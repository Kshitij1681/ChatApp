/**
 * Client-side mirror of the server's caps, in server/config.js.
 *
 * These exist to fail fast with a clear number — "images are capped at 5 MB"
 * before a 40 MB upload crawls up the wire only to be refused. The server's
 * copy is the authority; this one is a courtesy, and must never be the only
 * check anywhere.
 */
export const LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  perUser: 50 * 1024 * 1024,
  recordingMs: 60_000,
};
