/**
 * The three deletion operations, in one place.
 *
 * They share primitives — purging GridFS bytes, recomputing a sidebar preview,
 * parking a handle — and getting one of them subtly wrong is how deleted content
 * comes back. Keeping them adjacent means the rules are read together.
 *
 * What none of this can promise: deleted bodies survive in the Atlas oplog for
 * the replication window and in backup snapshots for the retention period, and
 * a recipient's browser may still hold image bytes it already cached. The README
 * says so plainly. "Delete for everyone" is not "unsend from reality".
 */
import mongoose from "mongoose";
import { Conversation } from "../models/Conversation.js";
import { Message, previewOf } from "../models/Message.js";
import { User } from "../models/User.js";
import { ReservedUsername } from "../models/ReservedUsername.js";
import { deleteFile, fileIdsOwnedBy } from "./gridfs.js";

/**
 * Deletes the GridFS bytes behind every message matching `filter`.
 *
 * Sequential, not Promise.all: a conversation can hold hundreds of files and
 * firing every delete at once would open hundreds of concurrent chunk deletes
 * against an M0 cluster. Deletion is not on a latency path — nobody is watching
 * a spinner — so the slower, kinder loop is the right trade.
 */
async function purgeMediaFor(filter) {
  const carriers = await Message.find({ ...filter, "attachment.fileId": { $exists: true } })
    .select("attachment.fileId")
    .lean();

  for (const row of carriers) {
    // Missing bytes are success. deleteFile() already treats "File not found" as
    // a no-op, which matters because a half-finished upload can leave a message
    // pointing at nothing.
    await deleteFile(row.attachment.fileId);
  }
  return carriers.length;
}

/**
 * Recomputes the sidebar snapshot from whatever message is now newest.
 *
 * Every deletion path ends here rather than patching `lastMessage` by hand. A
 * tombstone is still the newest message, so `previewOf` turns it into "Message
 * deleted" and the row stays in place; an emptied conversation clears the field
 * and sorts to the bottom.
 */
async function refreshLastMessage(conversationId) {
  const newest = await Message.findOne({ conversation: conversationId }).sort({ _id: -1 }).lean();

  if (!newest) {
    await Conversation.updateOne({ _id: conversationId }, { $unset: { lastMessage: "" } });
    return null;
  }

  const snapshot = {
    preview: previewOf(newest),
    kind: newest.kind,
    from: newest.from,
    at: newest.createdAt,
    deleted: !!newest.deletedForEveryone,
  };
  await Conversation.updateOne({ _id: conversationId }, { $set: { lastMessage: snapshot } });
  return snapshot;
}

/**
 * Message, for everyone. No time limit — that was an explicit product decision.
 *
 * Only the sender may do this, and the check belongs to the caller's query, not
 * to a flag passed in here. The document itself survives as a ~120-byte
 * tombstone: both sides keep agreeing on what happened and the timeline doesn't
 * reflow, which is the honest picture of what the server still holds.
 */
export async function tombstoneMessage(message, byUserId) {
  const fileId = message.attachment?.fileId ?? null;

  await Message.updateOne(
    { _id: message._id },
    {
      $set: { deletedForEveryone: true, deletedAt: new Date(), deletedBy: byUserId },
      // Unset, not emptied. A tombstone carries no body key at all, so a client
      // that forgets to check `deleted` renders nothing rather than stale text.
      $unset: { body: "", attachment: "" },
    },
  );

  // Bytes go after the pointer, never before. If the process dies between the
  // two, the worst case is an orphaned file nobody can reach — the reverse order
  // would leave a live message pointing at deleted bytes, which reads as a bug
  // to both people in the conversation.
  if (fileId) await deleteFile(fileId);

  const lastMessage = await refreshLastMessage(message.conversation);
  return { lastMessage };
}

/**
 * Conversation, for me. Silent by design: the other side is unaffected and is
 * not told, because "clear my copy" is not an event in their history.
 *
 * The bound is the newest message's id, not the wall clock. An ObjectId's
 * timestamp is second-granular, so a time-derived bound has to round, and either
 * rounding loses a message: down leaks one sent in the same second, up hides one
 * that arrives in the same second and never lets the thread revive. The id is
 * exact. Nothing is destroyed here, so a later message simply unhides the thread.
 */
export async function clearForMe(conversation, userId) {
  const newest = await Message.findOne({ conversation: conversation._id })
    .sort({ _id: -1 })
    .select("_id")
    .lean();

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        "participantState.$[me].clearedAt": new Date(),
        // An empty conversation has nothing to clear, so the bound stays unset
        // rather than becoming a bound that hides everything to come.
        ...(newest ? { "participantState.$[me].clearedUpTo": newest._id } : {}),
        "participantState.$[me].hidden": true,
      },
    },
    { arrayFilters: [{ "me.user": new mongoose.Types.ObjectId(String(userId)) }] },
  );
}

/**
 * Conversation, for everyone. Both copies go, and the other person is told.
 *
 * The notice is what makes this defensible rather than silent data destruction:
 * without it, someone's history would vanish with no account of where it went,
 * and they would reasonably conclude the app had lost it. So the conversation
 * document survives, emptied, carrying `closedByPeer` for the person who didn't
 * ask for this — their sidebar keeps a row that says what happened until they
 * dismiss it or someone writes again.
 */
export async function destroyForEveryone(conversation, byUserId) {
  const now = new Date();
  const peerId = conversation.otherThan(byUserId);

  await purgeMediaFor({ conversation: conversation._id });
  const { deletedCount } = await Message.deleteMany({ conversation: conversation._id });

  // Read the survivor *after* the delete, not before. Normally there is none. If
  // one is there it was written during this operation's one race — between the
  // purge and this write — and making it the bound keeps it out of both people's
  // history rather than letting it surface alone in an emptied thread.
  const raced = await Message.findOne({ conversation: conversation._id })
    .sort({ _id: -1 })
    .select("_id")
    .lean();

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        "participantState.$[me].clearedAt": now,
        "participantState.$[me].hidden": true,
        "participantState.$[me].closedByPeer": false,
        "participantState.$[them].clearedAt": now,
        "participantState.$[them].hidden": false,
        "participantState.$[them].closedByPeer": true,
        ...(raced
          ? {
              "participantState.$[me].clearedUpTo": raced._id,
              "participantState.$[them].clearedUpTo": raced._id,
            }
          : {}),
      },
      $unset: { lastMessage: "" },
    },
    {
      arrayFilters: [
        { "me.user": new mongoose.Types.ObjectId(String(byUserId)) },
        { "them.user": new mongoose.Types.ObjectId(String(peerId)) },
      ],
    },
  );

  return { peerId: String(peerId), deletedCount };
}

/**
 * Files this user uploaded that no surviving message points at.
 *
 * These are unreachable either way — an upload abandoned before it was sent, or
 * one whose message has since been purged. Nothing can ever serve them again, so
 * they are bytes with no owner in the UI sense. Both deletion modes collect them.
 */
async function orphanedFileIds(userId, ownedIds) {
  if (!ownedIds.length) return [];
  const attached = await Message.find({ "attachment.fileId": { $in: ownedIds } })
    .select("attachment.fileId")
    .lean();
  const live = new Set(attached.map((m) => String(m.attachment.fileId)));
  return ownedIds.filter((id) => !live.has(String(id)));
}

/**
 * Account deletion. Two modes, and the default is the conservative one.
 *
 * `anonymize` keeps the messages you sent, attributed to "Deleted user". It is
 * the default because a conversation is jointly authored: hard-deleting your half
 * tears holes in someone else's records of their own life, and the erasure right
 * you are exercising covers your personal data, not the counterparty's copy of a
 * conversation you both had. `purge` erases every message you ever sent, and is
 * offered because some people mean exactly that — but it has to be chosen.
 *
 * Either way the person stops existing as an identity: the handle is parked
 * forever, the OAuth link is severed, and the profile fields are gone.
 */
export async function deleteAccount(user, { purge = false } = {}) {
  const userId = user._id;
  const conversations = await Conversation.find({ participants: userId }).select("participants").lean();
  const owned = await fileIdsOwnedBy(userId);

  if (purge) {
    // Every byte, attached or not — the mode means what it says.
    for (const id of owned) await deleteFile(id);
    await Message.deleteMany({ from: userId });
  } else {
    for (const id of await orphanedFileIds(userId, owned)) await deleteFile(id);
  }

  // Park the handle before releasing it, and park it forever. A stranger who
  // could claim @you would inherit every place your name still appears in
  // someone else's history — the one impersonation this app can't detect.
  if (user.username) {
    await ReservedUsername.updateOne(
      { username: user.username },
      { $set: { reason: "deleted", formerUser: userId, at: new Date(), until: null } },
      { upsert: true },
    );
  }

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        deleted: true,
        deletedAt: new Date(),
        displayName: "Deleted user",
        // The provider pair is the login key, and it is unique. Severing it by
        // scrambling providerId — rather than unsetting it — means signing in
        // again creates a fresh account instead of resurrecting this one, and two
        // deleted accounts can't collide on the index.
        providerId: `deleted:${userId}`,
      },
      $unset: { username: "", avatarUrl: "", email: "", usernameChangedAt: "" },
    },
  );

  // Purging shifts what the newest message is, so every affected sidebar has to
  // be recomputed. Anonymize leaves the timeline intact but the preview may name
  // them, so it is refreshed too.
  for (const convo of conversations) await refreshLastMessage(convo._id);

  const sessions = await dropSessionsFor(userId);

  return {
    conversations: conversations.map((c) => ({
      id: String(c._id),
      peerId: String(c.participants.find((p) => String(p) !== String(userId))),
    })),
    sessions,
    purged: purge,
  };
}

/**
 * Ends every session this user has, on every device.
 *
 * connect-mongo stores the session as a JSON string, and passport puts the user
 * id at `passport.user` inside it — so the match is a substring search on that
 * exact key. Interpolating an id into a regex is normally where injection lives;
 * this one is safe because the value is a 24-character hex ObjectId read back
 * from our own database, which cannot contain a metacharacter. The collection
 * scan is fine: it runs once, on a collection with one row per active login.
 */
export async function dropSessionsFor(userId) {
  const hex = String(userId);
  if (!/^[0-9a-f]{24}$/i.test(hex)) return 0;
  const { deletedCount } = await mongoose.connection.db
    .collection("sessions")
    .deleteMany({ session: { $regex: `"user":"${hex}"` } });
  return deletedCount ?? 0;
}

