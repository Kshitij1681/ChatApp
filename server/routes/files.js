/**
 * GET /api/files/:id — authenticated attachment download.
 *
 * This is never a static directory. A public /uploads path would mean anyone
 * holding a URL can read private video, forever, with no way to revoke it.
 * Every byte served here is authorized against the conversation first.
 */
import { Router } from "express";
import { requireAuth, requireUsername, wrap } from "../lib/guards.js";
import { statFile, openDownload } from "../lib/gridfs.js";
import { safeContentType, dispositionFor, kindForMime } from "../lib/mime.js";
import { sanitizeFilename } from "../lib/sanitize.js";
import { Message } from "../models/Message.js";

const router = Router();

router.use(requireAuth, requireUsername);

/**
 * May this user read this file?
 *
 * Two ways to qualify, and no third: you are a participant in the conversation
 * whose message carries it, or you uploaded it and haven't attached it yet.
 * The second case is what makes an upload-then-send flow work without opening a
 * window where a guessed id is public.
 */
async function authorize(user, fileId, file) {
  const message = await Message.findOne({ "attachment.fileId": fileId })
    .select("conversation deletedForEveryone")
    .populate({ path: "conversation", select: "participants" })
    .lean();

  if (!message) {
    return String(file.metadata?.owner ?? "") === String(user._id);
  }
  // A tombstone's bytes are gone anyway; refuse rather than 404 from GridFS.
  if (message.deletedForEveryone) return false;

  return (message.conversation?.participants ?? []).some((p) => String(p) === String(user._id));
}

/**
 * Parses a single-range `bytes=` header. Multi-range is deliberately
 * unsupported — it requires a multipart/byteranges body, and no media element
 * asks for one. Returns null for "serve the whole thing", or "invalid" for a
 * range that cannot be satisfied.
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";

  let start;
  let end;
  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

router.get(
  "/files/:id",
  wrap(async (req, res) => {
    const file = await statFile(req.params.id);
    // Same 404 for "no such file" and "not yours". Distinguishing them would
    // turn this route into an oracle for which file ids exist.
    if (!file) return res.status(404).json({ error: "not_found" });
    if (!(await authorize(req.user, file._id, file))) return res.status(404).json({ error: "not_found" });

    const mime = safeContentType(file.contentType);
    const kind = kindForMime(file.contentType);
    const name = sanitizeFilename(file.filename);

    res.setHeader("Content-Type", mime);
    // Pin the type: without nosniff a browser may decide a text file is script.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${dispositionFor(kind)}; filename="${name}"`);
    res.setHeader("Accept-Ranges", "bytes");
    // private: a shared cache must not keep someone's private media. The README
    // is honest that the recipient's own browser may still hold bytes after a
    // delete — that is the limit of what this header can promise.
    res.setHeader("Cache-Control", "private, max-age=3600");

    const range = parseRange(req.headers.range, file.length);

    if (range === "invalid") {
      res.setHeader("Content-Range", `bytes */${file.length}`);
      return res.status(416).end();
    }

    if (!range) {
      res.setHeader("Content-Length", file.length);
      return pipe(res, openDownload(file._id));
    }

    // 206 with a byte range is what lets video and voice notes scrub. Without
    // it a seek re-downloads from zero.
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.length}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
    return pipe(res, openDownload(file._id, range));
  }),
);

/**
 * Headers are already sent by the time bytes flow, so a mid-stream failure
 * cannot become a JSON error — destroying the response is the only honest
 * signal left, and it tells the client the body is incomplete.
 */
function pipe(res, stream) {
  stream.on("error", (err) => {
    console.error("[files] stream failed:", err);
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export default router;
