/**
 * Socket registry. A user is a Set of sockets, not one socket, because tabs are
 * real — you go offline when the last one closes, not the first.
 *
 * This is an in-memory Map, which makes the server single-process by design.
 * Two instances would each know only half the room. Moving this to Redis is the
 * fix when that matters; see README.
 */
const sockets = new Map(); // userId -> Set<ws>

export function add(userId, ws) {
  const key = String(userId);
  let set = sockets.get(key);
  if (!set) {
    set = new Set();
    sockets.set(key, set);
  }
  set.add(ws);
  return set.size === 1; // first connection — this user just came online
}

export function remove(userId, ws) {
  const key = String(userId);
  const set = sockets.get(key);
  if (!set) return false;
  set.delete(ws);
  if (set.size > 0) return false;
  sockets.delete(key);
  return true; // last connection closed — this user is now offline
}

export function isOnline(userId) {
  return sockets.has(String(userId));
}

export function socketsFor(userId) {
  return sockets.get(String(userId)) ?? new Set();
}

/** Sends one frame to every tab a user has open. */
export function sendTo(userId, payload) {
  const frame = JSON.stringify(payload);
  let delivered = 0;
  for (const ws of socketsFor(userId)) {
    if (ws.readyState === 1) {
      ws.send(frame);
      delivered += 1;
    }
  }
  return delivered;
}

export function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export function onlineCount() {
  return sockets.size;
}

export function clearHub() {
  sockets.clear();
}
