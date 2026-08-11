/**
 * Token bucket, ported from screenshare-console/server/rooms.js.
 * Keyed by user id rather than socket, so opening a second tab doesn't hand
 * someone a second allowance.
 */
const buckets = new Map();

function take(key, capacity, refillPerSec) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, refilledAt: now };
    buckets.set(key, b);
  }
  const refill = Math.floor(((now - b.refilledAt) / 1000) * refillPerSec);
  if (refill > 0) {
    b.tokens = Math.min(capacity, b.tokens + refill);
    b.refilledAt = now;
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

/** 12 messages in reserve, refilling one per second. */
export const allowMessage = (userId) => take(`msg:${userId}`, 12, 1);

/** Uploads are far more expensive: 5 in reserve, one back every 10s. */
export const allowUpload = (userId) => take(`up:${userId}`, 5, 0.1);

/** Blunts guessing against the username claim endpoint. */
export const allowClaim = (userId) => take(`claim:${userId}`, 10, 0.05);

/**
 * A $text query is the most expensive read in the app. 20 in reserve is enough
 * for someone typing with debounce; the 2/s refill keeps a stuck key from
 * turning into a scan loop.
 */
export const allowSearch = (userId) => take(`find:${userId}`, 20, 2);

export function resetLimits() {
  buckets.clear();
}
