/**
 * MediaRecorder wrapper for voice and video notes.
 *
 * There is no single container every browser records: Chrome and Firefox do
 * WebM/Opus, Safari does MP4/AAC and refuses WebM outright. So the format is
 * negotiated at call time from what the browser admits to supporting, rather
 * than hardcoded and hoped for.
 */
import { LIMITS } from "./limits.js";

// Ordered by preference. Opus in WebM is small and good; MP4 is the Safari path.
const AUDIO_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

function pickType(candidates) {
  if (typeof MediaRecorder === "undefined") return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export function recordingSupported(mode = "audio") {
  return (
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!pickType(mode === "video" ? VIDEO_TYPES : AUDIO_TYPES)
  );
}

/** Turns a getUserMedia rejection into something worth showing a person. */
function describeDeviceError(err, mode) {
  const thing = mode === "video" ? "camera" : "microphone";
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return `Permission to use the ${thing} was denied.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${thing} found.`;
    case "NotReadableError":
      return `Another app is using the ${thing}.`;
    default:
      return `Could not start the ${thing}.`;
  }
}

/**
 * Starts recording and resolves with a handle.
 *
 * `onTick(ms)` fires about every 100ms so the UI can show elapsed time — a
 * recorder with no visible clock against a 60s cap is a trap.
 *
 * The returned handle must be settled with stop() or cancel(). Both release the
 * device tracks: skipping that leaves the camera light on, which reads as the
 * app still watching.
 */
export async function startRecording({ mode = "audio", onTick, onError } = {}) {
  const mimeType = pickType(mode === "video" ? VIDEO_TYPES : AUDIO_TYPES);
  if (!mimeType) throw new Error("unsupported");

  const constraints =
    mode === "video"
      ? { audio: true, video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: "user" } }
      : { audio: true };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw Object.assign(new Error(describeDeviceError(err, mode)), { code: "device", cause: err });
  }

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const startedAt = Date.now();

  let ticker = null;
  let capTimer = null;
  let settled = false;

  const release = () => {
    clearInterval(ticker);
    clearTimeout(capTimer);
    // Every track, every time. A stopped recorder does not stop the device.
    for (const track of stream.getTracks()) track.stop();
  };

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data?.size) chunks.push(e.data);
    });
  recorder.addEventListener("error", (e) => {
    release();
    onError?.(e.error ?? new Error("recorder_failed"));
  });

  const finished = new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });

  recorder.start(250); // timeslice, so chunks accumulate as we go

  ticker = setInterval(() => onTick?.(Date.now() - startedAt), 100);

  /** Resolves the recording into a File, or null if it was cancelled/empty. */
  async function finalize() {
    await finished;
    release();
    if (!chunks.length) return null;

    const durationMs = Math.min(Date.now() - startedAt, LIMITS.recordingMs);
    const blob = new Blob(chunks, { type: mimeType });
    // A real extension matters: it is what the recipient's OS opens it with.
    const ext = mimeType.includes("mp4") ? (mode === "video" ? "mp4" : "m4a") : mimeType.includes("ogg") ? "ogg" : "webm";
    const name = `${mode === "video" ? "video-note" : "voice-note"}-${new Date(startedAt)
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.${ext}`;

    const file = new File([blob], name, { type: mimeType });
    return { file, durationMs, mode };
  }

  // The 60s cap stops the recorder itself rather than merely refusing to upload,
  // so nobody talks for three minutes into something that was never recording.
  capTimer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, LIMITS.recordingMs);

  return {
    get state() {
      return recorder.state;
    },
    /** The live stream, for a video preview while recording. */
    stream,
    stop() {
      if (settled) return finalize();
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      return finalize();
    },
    cancel() {
      settled = true;
      chunks.length = 0; // discard before finalize can see them
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
