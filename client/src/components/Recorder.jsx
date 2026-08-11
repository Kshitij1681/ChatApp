import { useEffect, useRef, useState } from "react";
import { startRecording, recordingSupported } from "../lib/recorder.js";
import { LIMITS } from "../lib/limits.js";

const CAP = LIMITS.recordingMs;

/**
 * Voice and video notes.
 *
 * Press and hold to record, release to send, drag away to cancel — the gesture
 * people already know from every other messenger. It also works as click-to-
 * start / click-to-stop, because hold-to-record is miserable with a mouse and
 * impossible with a keyboard.
 */
export default function Recorder({ mode, disabled, onRecorded, onError, onBusyChange }) {
  const [elapsed, setElapsed] = useState(0);
  const [armed, setArmed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handleRef = useRef(null);
  const previewRef = useRef(null);
  const held = useRef(false);

  const supported = recordingSupported(mode);

  useEffect(() => {
    onBusyChange?.(armed);
  }, [armed, onBusyChange]);

  // A recorder left running when the thread changes would keep the mic light on
  // and surface a note in the wrong conversation.
  useEffect(() => () => handleRef.current?.cancel(), []);

  async function begin() {
    if (disabled || armed || !supported) return;
    setElapsed(0);
    setCancelling(false);
    try {
      const handle = await startRecording({
        mode,
        onTick: setElapsed,
        onError: (err) => {
          handleRef.current = null;
          setArmed(false);
          onError?.(err.message ?? "Recording failed.");
        },
      });
      // The pointer may already be up: a quick tap can finish before
      // getUserMedia resolves, and without this the recording never stops.
      if (!held.current && mode === "audio") {
        handle.cancel();
        return;
      }
      handleRef.current = handle;
      setArmed(true);
      if (previewRef.current) previewRef.current.srcObject = handle.stream;
    } catch (err) {
      onError?.(err.message ?? "Could not start recording.");
    }
  }

  async function finish(cancel = false) {
    const handle = handleRef.current;
    handleRef.current = null;
    setArmed(false);
    if (!handle) return;

    if (cancel) {
      handle.cancel();
      setElapsed(0);
      return;
    }

    const result = await handle.stop();
    setElapsed(0);
    // Under a second is almost always a mis-tap, and an empty result means the
    // recorder produced nothing worth sending.
    if (!result || result.durationMs < 800) return;
    onRecorded(result);
  }

  // The cap stops the recorder itself; this mirrors it in the UI so the button
  // doesn't sit there claiming to still be recording.
  useEffect(() => {
    if (armed && elapsed >= CAP) finish(false);
  }, [armed, elapsed]);

  if (!supported) return null;

  const seconds = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const nearCap = elapsed > CAP - 10_000;

  return (
    <>
      {armed ? (
        <div className="absolute inset-x-4 bottom-full mb-2 flex items-center gap-3 rounded-md border border-line bg-raised px-3 py-2 shadow-sm">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-post" aria-hidden="true" />
          <span className="data tabular-nums" aria-live="polite">
            {clock}
          </span>
          <span className={`data flex-1 ${nearCap ? "text-post" : "text-faint"}`}>
            {cancelling ? "Release to cancel" : nearCap ? `${Math.ceil((CAP - elapsed) / 1000)}s left` : "Release to send"}
          </span>

          {mode === "video" ? (
            <video
              ref={previewRef}
              autoPlay
              muted
              playsInline
              className="size-14 shrink-0 rounded object-cover"
            />
          ) : null}

          <button
            type="button"
            onClick={() => finish(true)}
            className="data text-post underline-offset-2 hover:underline"
          >
            cancel
          </button>
        </div>
      ) : null}

      <button
        type="button"
        disabled={disabled}
        aria-label={armed ? `Stop recording ${mode === "video" ? "video" : "voice"} note` : `Record a ${mode === "video" ? "video" : "voice"} note`}
        onPointerDown={(e) => {
          e.preventDefault();
          held.current = true;
          begin();
        }}
        onPointerUp={() => {
          held.current = false;
          // A click-started recording stays armed; a held one sends on release.
          if (armed && elapsed > 400) finish(cancelling);
        }}
        onPointerLeave={() => setCancelling(armed)}
        onPointerEnter={() => setCancelling(false)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            armed ? finish(false) : begin();
          }
          if (e.key === "Escape" && armed) finish(true);
        }}
        className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-30 max-md:size-9 ${
          armed
            ? cancelling
              ? "bg-post text-white"
              : "bg-post/15 text-post"
            : "text-ink-soft hover:bg-ground hover:text-ink"
        }`}
      >
        {mode === "video" ? <VideoIcon /> : <MicIcon />}
      </button>
    </>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
      <rect x="2.5" y="5.5" width="10" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m12.5 10 5-3v6l-5-3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
