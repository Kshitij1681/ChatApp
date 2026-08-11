import mongoose from "mongoose";

const { Schema } = mongoose;

const participantStateSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // "Delete for me" sets both. Every message query and the search query must
    // filter on `clearedUpTo`, or cleared history leaks back through the search
    // box. It holds the id of the newest message that existed when they cleared,
    // which splits the thread exactly where a timestamp cannot — an ObjectId's
    // clock is second-granular, so a date-derived bound loses a message whichever
    // way it rounds. lib/ids.js has the full account. `clearedAt` is when they
    // did it, kept for display only; never filter on it.
    clearedAt: Date,
    clearedUpTo: Schema.Types.ObjectId,
    // Hidden from the sidebar until the next incoming message unhides it.
    hidden: { type: Boolean, default: false },
    // Set when the other person destroyed the conversation for both of us.
    closedByPeer: { type: Boolean, default: false },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      required: true,
      validate: [(v) => v.length === 2, "a conversation has exactly two participants"],
    },
    // Sorted ids joined with ":". Unique, so A→B and B→A can only ever resolve
    // to one document even if both people hit "message" at the same moment.
    pairKey: { type: String, required: true, unique: true },

    lastMessage: {
      preview: String,
      kind: String,
      from: { type: Schema.Types.ObjectId, ref: "User" },
      at: Date,
      deleted: Boolean,
    },

    participantState: [participantStateSchema],
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1, "lastMessage.at": -1 });

export function pairKeyFor(a, b) {
  return [String(a), String(b)].sort().join(":");
}

/** The other participant's id, given one of them. */
conversationSchema.methods.otherThan = function (userId) {
  return this.participants.find((p) => String(p) !== String(userId));
};

conversationSchema.methods.stateFor = function (userId) {
  return this.participantState.find((s) => String(s.user) === String(userId));
};

conversationSchema.methods.isParticipant = function (userId) {
  return this.participants.some((p) => String(p) === String(userId));
};

/**
 * Find-or-create, tolerant of the race. Two people pressing "message" at once
 * both miss the read and both insert; the unique index on pairKey turns the
 * loser into E11000, and we simply re-read the winner's document.
 */
conversationSchema.statics.between = async function (a, b) {
  const pairKey = pairKeyFor(a, b);
  const existing = await this.findOne({ pairKey });
  if (existing) return existing;
  try {
    return await this.create({
      participants: [a, b],
      pairKey,
      participantState: [{ user: a }, { user: b }],
    });
  } catch (err) {
    if (err?.code === 11000) return this.findOne({ pairKey });
    throw err;
  }
};

export const Conversation =
  mongoose.models.Conversation ?? mongoose.model("Conversation", conversationSchema);
