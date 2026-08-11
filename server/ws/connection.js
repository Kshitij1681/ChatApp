import { WebSocketServer } from "ws";
import { originAllowed } from "../config.js";
import { getSessionMiddleware } from "../auth/session.js";
import { User } from "../models/User.js";
import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { add, remove, send, sendTo } from "./hub.js";
import { handleMessage } from "./handlers.js";

/**
 * Runs the express-session middleware over a raw upgrade request. The session
 * cookie rides the handshake automatically, so this is the whole trick — no
 * token in the query string, and one source of truth for who someone is.
 *
 * getSessionMiddleware() returns the same instance the HTTP app mounted, so a
 * cookie is read here exactly the way it is read on a normal request.
 */
function loadSession(req) {
  return new Promise((resolve) => {
    getSessionMiddleware()(req, {}, () => resolve(req.session?.passport?.user ?? null));
  });
}

export function attachWebSocket(server) {
  // noServer: we do the auth check before handleUpgrade, so an unauthenticated
  // socket never becomes a socket at all.
  //
  // maxPayload caps frames at the protocol level — ws closes anything larger
  // without buffering it. The application check in handlers.js is the one that
  // replies with a readable error; this is the one that stops a client from
  // making us hold 100 MB in memory first.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", async (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws") return socket.destroy();

    // Browsers do NOT apply CORS to WebSocket handshakes, so without this any
    // page on the internet could open an authenticated socket.
    if (!originAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }

    try {
      const userId = await loadSession(req);
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }

      const user = await User.findById(userId);
      if (!user || user.deleted || !user.username) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = String(user._id);
        ws.username = user.username;
        wss.emit("connection", ws, req);
      });
    } catch (err) {
      console.error("[ws] upgrade failed:", err);
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Listeners are registered synchronously, before anything is awaited. An
    // `await` here would open a window in which the socket is connected but
    // deaf, and a client that sends immediately after `hello` would have its
    // first message silently dropped.
    ws.on("message", (raw) => {
      handleMessage(ws, raw).catch((err) => {
        console.error("[ws] handler failed:", err);
        send(ws, { type: "error", error: "server_error" });
      });
    });

    ws.on("close", () => {
      if (!remove(ws.userId, ws)) return; // another tab is still open
      const now = new Date();
      Promise.all([
        User.updateOne({ _id: ws.userId }, { $set: { online: false, lastSeenAt: now } }),
        announcePresence(ws.userId, false, now),
      ]).catch((err) => console.error("[ws] close cleanup failed:", err));
    });

    const cameOnline = add(ws.userId, ws);
    send(ws, { type: "hello", userId: ws.userId, username: ws.username });

    if (cameOnline) {
      Promise.all([
        User.updateOne({ _id: ws.userId }, { $set: { online: true, lastSeenAt: new Date() } }),
        announcePresence(ws.userId, true),
        flushDelivery(ws.userId),
      ]).catch((err) => console.error("[ws] presence announce failed:", err));
    }
  });

  // A socket through a dead NAT or a slept laptop stays "open" forever without
  // this. 30s ping, and anything that misses a round is terminated.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

/**
 * Presence goes only to people you actually share a conversation with. A global
 * broadcast would tell every stranger on the service when you sit down.
 */
async function announcePresence(userId, online, at = new Date()) {
  const convos = await Conversation.find({ participants: userId }).select("participants").lean();
  const peers = new Set();
  for (const c of convos) {
    for (const p of c.participants) {
      if (String(p) !== String(userId)) peers.add(String(p));
    }
  }
  for (const peer of peers) {
    sendTo(peer, { type: "presence", userId: String(userId), online, lastSeenAt: at });
  }
}

/**
 * Stamp everything that arrived while this user had no socket.
 *
 * `msg:send` can only mark a message delivered if the recipient is connected at
 * that instant; anything sent to a closed laptop stays `deliveredAt: null`.
 * Without this sweep it stays null forever — the sender's message sits on one
 * tick for good, and the only thing that ever clears it is the recipient
 * actually opening the thread and reading it. That reads as "never arrived"
 * when the truth is "arrived while they were away".
 *
 * Per conversation rather than one bulk update, because the receipt is
 * addressed: each sender learns about their own thread and nothing else. The
 * cost is one update per thread with a backlog, which is bounded by how many
 * people wrote to you while you were gone.
 *
 * Exactly once falls out of `modifiedCount`. The filter matches only
 * `deliveredAt: null`, so a second connection — the second tab, a reconnect
 * after a dropped socket — matches nothing and stays silent. This runs only
 * when `add()` reports the *first* socket, so opening a tab while another is
 * already open doesn't even reach here.
 */
async function flushDelivery(userId) {
  const convos = await Conversation.find({ participants: userId }).select("participants").lean();
  const now = new Date();

  for (const convo of convos) {
    const result = await Message.updateMany(
      {
        conversation: convo._id,
        from: { $ne: userId },
        deliveredAt: null,
        readAt: null,
        deletedForEveryone: false,
      },
      { $set: { deliveredAt: now } },
    );
    if (result.modifiedCount === 0) continue;

    // Only the other participant is told: this is *their* receipt. The person
    // who just connected already sees these as incoming messages.
    const sender = convo.participants.find((p) => String(p) !== String(userId));
    sendTo(String(sender), {
      type: "msg:status",
      conversationId: String(convo._id),
      status: "delivered",
      at: now,
      upTo: null,
    });
  }
}
