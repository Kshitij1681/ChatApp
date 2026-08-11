import mongoose from "mongoose";

const { Schema } = mongoose;

const attachmentSchema = new Schema(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    name: String,
    mime: String,
    size: Number,
    durationMs: Number, // audio + video
    width: Number,
    height: Number, // images + video
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    from: { type: Schema.Types.ObjectId, ref: "User", required: true },

    kind: { type: String, enum: ["text", "image", "file", "video", "audio"], default: "text" },
    body: String,
    attachment: attachmentSchema,

    deliveredAt: Date,
    readAt: Date,

    // Tombstone. The document stays forever (~120 bytes) so the timeline
    // doesn't reflow and both sides agree on what happened; body and
    // attachment are unset and the GridFS chunks are purged.
    deletedForEveryone: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// Pagination walks this backwards from a cursor. Descending on _id gives both
// "newest first" and the cursor comparison in one index.
messageSchema.index({ conversation: 1, _id: -1 });
// Unread count: from-someone-else, unread, not a tombstone.
messageSchema.index({ conversation: 1, from: 1, readAt: 1 });
messageSchema.index({ body: "text" });

/**
 * Wire shape. A tombstone deliberately carries no body or attachment key at
 * all, so a client that forgets to check `deleted` renders nothing rather than
 * stale text.
 */
export function publicMessage(m) {
  const base = {
    id: String(m._id),
    conversationId: String(m.conversation),
    from: String(m.from),
    kind: m.kind,
    at: m.createdAt,
    deliveredAt: m.deliveredAt ?? null,
    readAt: m.readAt ?? null,
  };
  if (m.deletedForEveryone) {
    return { ...base, kind: "text", deleted: true, deletedAt: m.deletedAt };
  }
  return {
    ...base,
    deleted: false,
    body: m.body ?? "",
    attachment: m.attachment
      ? {
          fileId: String(m.attachment.fileId),
          name: m.attachment.name,
          mime: m.attachment.mime,
          size: m.attachment.size,
          durationMs: m.attachment.durationMs ?? null,
          width: m.attachment.width ?? null,
          height: m.attachment.height ?? null,
        }
      : null,
  };
}

/** Sidebar preview text. Tombstones and media get a label, not content. */
export function previewOf(m) {
  if (m.deletedForEveryone) return "Message deleted";
  if (m.kind === "image") return "Photo";
  if (m.kind === "video") return "Video";
  if (m.kind === "audio") return "Voice note";
  if (m.kind === "file") return m.attachment?.name ?? "File";
  return (m.body ?? "").slice(0, 140);
}

export const Message = mongoose.models.Message ?? mongoose.model("Message", messageSchema);
