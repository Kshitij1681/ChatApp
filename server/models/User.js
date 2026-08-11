import mongoose from "mongoose";

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    // Identity is the provider pair, never the email — two providers on the
    // same address are two accounts. See README.
    provider: { type: String, required: true, enum: ["google", "github", "test"] },
    providerId: { type: String, required: true },

    username: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    usernameChangedAt: Date,

    displayName: { type: String, required: true },
    avatarUrl: String,
    // Stored because OAuth hands it over and support needs it. NEVER returned
    // from search — see publicUser().
    email: { type: String, lowercase: true, trim: true },

    online: { type: Boolean, default: false },
    lastSeenAt: Date,

    storageUsed: { type: Number, default: 0 },

    // Account deletion tombstone. The document survives so foreign keys in
    // other people's conversations still resolve to a name.
    deleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ provider: 1, providerId: 1 }, { unique: true });
userSchema.index({ username: "text", displayName: "text" });
// `username` already has a unique index from the field's `unique: true`, so
// declaring one here too would be a second, redundant B-tree.
userSchema.index({ displayName: 1 });

export const USERNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Milliseconds until this user may change their handle again; 0 if now. */
userSchema.methods.cooldownRemaining = function () {
  if (!this.usernameChangedAt) return 0;
  const elapsed = Date.now() - this.usernameChangedAt.getTime();
  return Math.max(0, USERNAME_COOLDOWN_MS - elapsed);
};

/**
 * The only shape a user is ever allowed to leave the server in.
 * Email is absent by construction rather than by remembering to strip it —
 * "search all users" would otherwise let anyone harvest the whole table.
 */
export function publicUser(u) {
  if (!u) return null;
  if (u.deleted) {
    return {
      id: String(u._id),
      username: null,
      displayName: "Deleted user",
      avatarUrl: null,
      online: false,
      lastSeenAt: null,
      deleted: true,
    };
  }
  return {
    id: String(u._id),
    username: u.username ?? null,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? null,
    online: !!u.online,
    lastSeenAt: u.lastSeenAt ?? null,
    deleted: false,
  };
}

export const User = mongoose.models.User ?? mongoose.model("User", userSchema);
