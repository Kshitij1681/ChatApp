/**
 * Upload and download of attachment bytes.
 *
 * Bytes go over HTTP, never base64-over-WebSocket: base64 inflates payloads by
 * a third and a 25 MB frame would block the event loop for everyone.
 */
import { Router } from "express";
import multer from "multer";
import { LIMITS } from "../config.js";
import { requireAuth, requireUsername, wrap } from "../lib/guards.js";
import { allowUpload } from "../lib/ratelimit.js";
import { sanitizeFilename } from "../lib/sanitize.js";
import { kindForMime, limitForKind, safeContentType } from "../lib/mime.js";
import { uploadBuffer, totalBytes, bytesOwnedBy } from "../lib/gridfs.js";

const router = Router();

// Memory storage, not multer-gridfs-storage: that package is unmaintained and
// does not work with the mongoose 8 driver. The buffer never exceeds the multer
// ceiling below, so holding it briefly is bounded.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.upload, files: 1 },
});

router.use(requireAuth, requireUsername);

/**
 * POST /api/uploads — store bytes, return a fileId.
 *
 * Upload is deliberately separate from sending: the client gets a fileId, then
 * references it in a msg:send. A failed upload therefore costs no message, and
 * a slow one doesn't hold a socket frame open.
 */
router.post(
  "/uploads",
  (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      // Multer's own errors are not Express errors; translated here so the
      // client gets a readable 413 instead of a 500.
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "too_large", limit: LIMITS.upload });
      }
      if (err) return next(err);
      next();
    }),
  wrap(async (req, res) => {
    if (!allowUpload(String(req.user._id))) return res.status(429).json({ error: "rate_limited" });
    if (!req.file) return res.status(400).json({ error: "no_file" });

    const kind = kindForMime(req.file.mimetype);
    if (!kind) return res.status(415).json({ error: "unsupported_type", mime: req.file.mimetype });

    const limit = limitForKind(kind);
    if (req.file.size > limit) return res.status(413).json({ error: "too_large", limit, kind });

    // Quota is recomputed from GridFS rather than trusted from the counter on
    // the user: deletes must give space back, and a drifted counter would
    // eventually lock someone out of their own account.
    const used = await bytesOwnedBy(req.user._id);
    if (used + req.file.size > LIMITS.perUser) {
      return res.status(507).json({ error: "quota_exceeded", used, quota: LIMITS.perUser });
    }

    // The cluster-wide kill switch. M0 is 512 MB for everything including
    // indexes and sessions, so this stops short of the wall on purpose.
    const total = await totalBytes();
    if (total + req.file.size > LIMITS.global) {
      return res.status(507).json({ error: "storage_full" });
    }

    const name = sanitizeFilename(req.file.originalname);
    const fileId = await uploadBuffer({
      buffer: req.file.buffer,
      filename: name,
      mime: safeContentType(req.file.mimetype),
      ownerId: req.user._id,
    });

    res.status(201).json({
      file: { fileId, name, mime: safeContentType(req.file.mimetype), size: req.file.size, kind },
    });
  }),
);

/** GET /api/me/storage — the numbers behind the usage bar in Settings. */
router.get(
  "/me/storage",
  wrap(async (req, res) => {
    const [used, total] = await Promise.all([bytesOwnedBy(req.user._id), totalBytes()]);
    res.json({
      used,
      quota: LIMITS.perUser,
      global: { used: total, cap: LIMITS.global, full: total >= LIMITS.global },
      limits: { image: LIMITS.image, audio: LIMITS.audio, video: LIMITS.video, file: LIMITS.file },
    });
  }),
);

export default router;
