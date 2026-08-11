import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Handles released by a change are parked here for 30 days; handles freed by
 * account deletion are parked forever (`until: null`). Without this, someone
 * could claim a handle that still appears in another person's chat history and
 * pass themselves off as its previous owner.
 */
const reservedSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  reason: { type: String, enum: ["changed", "deleted"], required: true },
  formerUser: { type: Schema.Types.ObjectId, ref: "User" },
  at: { type: Date, default: Date.now },
  // null = never releases.
  until: { type: Date, default: null },
});

/** True if the handle is parked and not yet released. */
reservedSchema.statics.isBlocked = async function (username) {
  const row = await this.findOne({ username }).lean();
  if (!row) return false;
  if (row.until === null) return true;
  return row.until.getTime() > Date.now();
};

export const ReservedUsername =
  mongoose.models.ReservedUsername ?? mongoose.model("ReservedUsername", reservedSchema);
