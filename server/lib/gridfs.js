/**
 * GridFS access. Everything that touches file bytes goes through here, so the
 * bucket name and the delete-the-chunks-too rule live in exactly one place.
 *
 * `mongodb` is a direct dependency even though mongoose pulls it in, because
 * this file imports it directly and an undeclared dependency is one `npm
 * install` away from vanishing. It is pinned to mongoose's own range
 * (`~6.20.0`) rather than the newest 6.x on purpose: the bucket below is built
 * from *this* copy of the driver but handed `mongoose.connection.db` from
 * mongoose's, and a range that doesn't dedupe to one copy puts two drivers in
 * the graph passing each other's objects around. Bump this when mongoose bumps.
 */
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";

const BUCKET = "attachments";

let cached = null;

/**
 * Lazy, because the connection isn't open at import time — building the bucket
 * eagerly would bind to a null db and fail at boot rather than at first use.
 */
export function bucket() {
  if (cached) return cached;
  const db = mongoose.connection.db;
  if (!db) throw new Error("gridfs: no database connection yet");
  cached = new GridFSBucket(db, { bucketName: BUCKET });
  return cached;
}

/** Test helper: a dropped database invalidates the cached bucket handle. */
export function resetBucket() {
  cached = null;
}

export function uploadBuffer({ buffer, filename, mime, ownerId }) {
  return new Promise((resolve, reject) => {
    const stream = bucket().openUploadStream(filename, {
      contentType: mime,
      // The owner rides the file itself. /api/files/:id authorizes against this
      // for a file not yet attached to a message, so an upload is never
      // readable by a stranger who guesses the id.
      metadata: { owner: String(ownerId), uploadedAt: new Date() },
    });
    stream.on("error", reject);
    stream.on("finish", () => resolve(String(stream.id)));
    stream.end(buffer);
  });
}

export async function statFile(fileId) {
  const id = toObjectId(fileId);
  if (!id) return null;
  const [file] = await bucket().find({ _id: id }).limit(1).toArray();
  return file ?? null;
}

/**
 * Opens a byte range. GridFS takes an exclusive end, HTTP's Range is inclusive,
 * so the +1 here is the whole difference between a correct last byte and a
 * truncated one.
 */
export function openDownload(fileId, { start, end } = {}) {
  const id = toObjectId(fileId);
  if (!id) throw new Error("gridfs: bad file id");
  if (start === undefined) return bucket().openDownloadStream(id);
  return bucket().openDownloadStream(id, { start, end: end + 1 });
}

/**
 * Deletes the file and its chunks. Missing is success: delete is called from
 * cleanup paths where a half-finished upload may have left nothing behind, and
 * throwing there would strand the caller mid-transaction.
 */
export async function deleteFile(fileId) {
  const id = toObjectId(fileId);
  if (!id) return false;
  try {
    await bucket().delete(id);
    return true;
  } catch (err) {
    if (String(err?.message ?? "").includes("File not found")) return false;
    throw err;
  }
}

/** Bytes stored across every user — drives the global kill switch. */
export async function totalBytes() {
  const [row] = await mongoose.connection.db
    .collection(`${BUCKET}.files`)
    .aggregate([{ $group: { _id: null, bytes: { $sum: "$length" } } }])
    .toArray();
  return row?.bytes ?? 0;
}

/** Bytes stored by one user, recomputed from the files themselves. */
export async function bytesOwnedBy(userId) {
  const [row] = await mongoose.connection.db
    .collection(`${BUCKET}.files`)
    .aggregate([
      { $match: { "metadata.owner": String(userId) } },
      { $group: { _id: null, bytes: { $sum: "$length" } } },
    ])
    .toArray();
  return row?.bytes ?? 0;
}

/**
 * Every file this user uploaded, attached to a message or not.
 *
 * Account deletion needs both: the attached ones are their media, and the
 * unattached ones are uploads that never became a message. Leaving the latter
 * behind would keep private bytes alive with no document left to reach them by,
 * which is the worst of both — undeletable and still counted against storage.
 */
export async function fileIdsOwnedBy(userId) {
  const rows = await mongoose.connection.db
    .collection(`${BUCKET}.files`)
    .find({ "metadata.owner": String(userId) }, { projection: { _id: 1 } })
    .toArray();
  return rows.map((r) => r._id);
}

function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;
}
