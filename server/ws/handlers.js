import { Conversation } from "../models/Conversation.js";
import { Message, publicMessage, previewOf } from "../models/Message.js";
import { sanitizeText } from "../lib/sanitize.js";
import { allowMessage } from "../lib/ratelimit.js";
import { statFile } from "../lib/gridfs.js";
import { kindForMime } from "../lib/mime.js";
import { LIMITS } from "../config.js";
import { asObjectId } from "../lib/ids.js";
import { isOnline, send, sendTo } from "./hub.js";

const MAX_FRAME = 8 * 1024; // a text frame has no business being larger

/** Client-reported media dimensions and duration are hints for layout, so they
 *  are clamped rather than trusted — a bogus value would only skew our own UI. */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000) : undefined;
}

function clampDuration(value) {
  const n = positiveInt(value);
  return n === undefined ? undefined : Math.min(n, LIMITS.recordingMs);
}

/**
 * Every handler takes the actor from `ws.userId`. A `from` field in the payload
 * is ignored on purpose — trusting one would let anyone speak as anyone.
 */
export async function handleMessage(ws, raw) {
  if (raw.length > MAX_FRAME) return send(ws, { type: "error", error: "frame_too_large" });

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(ws, { type: "error", error: "bad_json" });
  }

  switch (msg?.type) {
    case "msg:send":
      return sendMessage(ws, msg);
    case "msg:read":
      return markRead(ws, msg);
    case "typing":
      return relayTyping(ws, msg);
    case "ping":
      return send(ws, { type: "pong" });
    default:
      return send(ws, { type: "error", error: "unknown_type" });
  }
}

/** Loads a conversation only if this user is in it. Returns null otherwise. */
async function participantConversation(userId, conversationId) {
  const id = asObjectId(conversationId);
  // A socket frame is wholly attacker-shaped, so the id is checked before it can
  // reach a query. An uncastable id here would throw inside the handler and kill
  // the frame with a generic error rather than the honest "not_found".
  if (!id) return null;
  const convo = await Conversation.findById(id);
  if (!convo || !convo.isParticipant(userId)) return null;
  return convo;
}

async function sendMessage(ws, msg) {
  // Every rejection below carries the clientId back. Without it the sender knows
  // *a* message failed but not which one, so the optimistic bubble spins forever.
  const reject = (error) => send(ws, { type: "error", error, clientId: msg.clientId ?? null });

  if (!allowMessage(ws.userId)) return reject("rate_limited");

  const convo = await participantConversation(ws.userId, msg.conversationId);
  if (!convo) return reject("not_found");

  // An attachment is referenced by a fileId from POST /api/uploads, never by
  // bytes on the socket. The file's metadata.owner is re-checked here: without
  // it, a guessed id would let someone attach a stranger's file to their own
  // message and gain a legitimate way to read it.
  let attachment = null;
  let kind = "text";
  if (msg.fileId) {
    const file = await statFile(msg.fileId);
    if (!file) return reject("file_not_found");
    if (String(file.metadata?.owner ?? "") !== String(ws.userId)) return reject("file_not_found");

    const attached = await Message.exists({ "attachment.fileId": file._id });
    // One file, one message. Reusing an id across messages would mean deleting
    // either one destroys the other's bytes.
    if (attached) return reject("file_in_use");

    kind = kindForMime(file.contentType) ?? "file";
    attachment = {
      fileId: file._id,
      name: file.filename,
      mime: file.contentType,
      size: file.length,
      durationMs: clampDuration(msg.durationMs),
      width: positiveInt(msg.width),
      height: positiveInt(msg.height),
    };
  }

  const body = sanitizeText(msg.body);
  // A caption may be empty when a file carries the message; text alone may not.
  if (!body && !attachment) return reject("empty");

  const peer = String(convo.otherThan(ws.userId));
  // Delivery is stamped at write time when a socket is open for them, so the
  // sender's tick is honest without a second round trip.
  const deliveredAt = isOnline(peer) ? new Date() : null;

  const doc = await Message.create({
    conversation: convo._id,
    from: ws.userId,
    kind,
    body,
    attachment,
    deliveredAt,
  });

  const wire = publicMessage(doc);

  // "Delete for me" hid this thread; a new message brings it back. The peer's
  // clearedAt is untouched — their old history stays cleared.
  await Conversation.updateOne(
    { _id: convo._id },
    {
      $set: {
        lastMessage: { preview: previewOf(doc), kind: doc.kind, from: doc.from, at: doc.createdAt, deleted: false },
        "participantState.$[peer].hidden": false,
        "participantState.$[peer].closedByPeer": false,
      },
    },
    { arrayFilters: [{ "peer.user": convo.otherThan(ws.userId) }] },
  );

  // `clientId` lets the sender swap its optimistic bubble for the real row.
  send(ws, { type: "msg:new", message: wire, clientId: msg.clientId ?? null });
  sendTo(peer, { type: "msg:new", message: wire });
}

async function markRead(ws, msg) {
  const convo = await participantConversation(ws.userId, msg.conversationId);
  if (!convo) return send(ws, { type: "error", error: "not_found" });

  const now = new Date();
  const filter = {
    conversation: convo._id,
    from: { $ne: ws.userId },
    readAt: null,
    deletedForEveryone: false,
  };
  // Reading up to a point, when the client names one; the whole thread otherwise.
  // An unusable `upTo` is refused rather than dropped — falling through to the
  // no-bound branch would mark the entire thread read on a typo'd id.
  if (msg.upTo !== undefined && msg.upTo !== null) {
    const upTo = asObjectId(msg.upTo);
    if (!upTo) return send(ws, { type: "error", error: "bad_cursor" });
    filter._id = { $lte: upTo };
  }

  const result = await Message.updateMany(filter, [
    // $ifNull keeps delivery monotonic: a message read without ever having been
    // marked delivered gets both stamps, but a real earlier delivery survives.
    { $set: { readAt: now, deliveredAt: { $ifNull: ["$deliveredAt", now] } } },
  ]);
  if (result.modifiedCount === 0) return;

  sendTo(String(convo.otherThan(ws.userId)), {
    type: "msg:status",
    conversationId: String(convo._id),
    status: "read",
    at: now,
    upTo: msg.upTo ?? null,
  });
}

async function relayTyping(ws, msg) {
  const convo = await participantConversation(ws.userId, msg.conversationId);
  if (!convo) return;
  // Ephemeral and unpersisted. The client throttles and expires it after 3s.
  sendTo(String(convo.otherThan(ws.userId)), {
    type: "typing",
    conversationId: String(convo._id),
    userId: ws.userId,
    typing: !!msg.typing,
  });
}
