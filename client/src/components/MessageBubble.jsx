import { useEffect, useRef, useState } from "react";
import { clockOf, bytesOf } from "../lib/format.js";
import { fileUrl } from "../lib/api.js";

/**
 * A message: text, and any attachment it carries.
 *
 * The body is rendered as a text node, never as HTML. That is the whole XSS
 * defense on this surface, and it must stay that way: no dangerouslySetInnerHTML
 * in this file, ever.
 */
export default function MessageBubble({ message, mine, showMeta, found, onDelete }) {
  if (message.deleted) return <Tombstone mine={mine} at={message.at} showMeta={showMeta} />;

  const media = message.attachment;
  // Media sets its own width, so the bubble sheds the padding that would frame
  // a photo in a border of bubble colour.
  const bare = media && (message.kind === "image" || message.kind === "video") && !message.body;
  // Only your own, and only once it exists server-side — there is nothing to
  // delete while the optimistic bubble is still in flight.
  const deletable = mine && onDelete && !message.pending && !message.failed;

  return (
    <div className={`group flex items-center gap-1 ${mine ? "justify-end" : "justify-start"}`}>
      {deletable ? <DeleteHandle onDelete={() => onDelete(message)} /> : null}
      <div
        className={`rise max-w-[min(34rem,78%)] overflow-hidden rounded-md ${bare ? "p-1" : "px-3 py-2"} ${
          mine
            ? "rounded-br-sm bg-wire text-white"
            : "rounded-bl-sm border border-line bg-raised text-ink"
        } ${message.failed ? "opacity-60 ring-1 ring-post" : ""} ${
          // The message someone searched for. A ring rather than a colour change,
          // so it still reads as theirs or yours at a glance.
          found ? "ring-2 ring-post ring-offset-2 ring-offset-ground" : ""
        }`}
      >
        {media ? <Attachment message={message} mine={mine} /> : null}

        {/* `whitespace-pre-wrap` preserves the newlines the sanitizer kept. */}
        {message.body ? (
          <p className={`wrap-anywhere whitespace-pre-wrap ${media ? "mt-2" : ""}`}>{message.body}</p>
        ) : null}

        {showMeta ? (
          <p
            className={`data mt-0.5 flex items-center justify-end gap-1 ${bare ? "px-2 pb-1" : ""} ${
              mine ? "text-white/60" : "text-faint"
            }`}
          >
            {message.failed ? <span className="text-post">not sent</span> : clockOf(message.at)}
            {mine && !message.failed ? <Receipt message={message} /> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Deletes hide until you hover or tab to the message. A permanent button beside
 * every bubble makes an irreversible action the most visible thing in the
 * thread; this keeps it one gesture away without putting it under the cursor.
 */
function DeleteHandle({ onDelete }) {
  return (
    <button
      type="button"
      onClick={onDelete}
      aria-label="Delete this message for everyone"
      title="Delete for everyone"
      className="grid size-7 shrink-0 place-items-center rounded-full text-faint opacity-0 transition-opacity hover:bg-raised hover:text-post focus-visible:opacity-100 group-hover:opacity-100"
    >
      <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
        <path
          d="M4.5 6h11M8 6V4.5h4V6M6.5 6l.6 9.5h5.8L13.5 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Renders by kind. Every src points at /api/files/:id, which authorizes the
 * requester against the conversation on each request — there is no public path
 * to these bytes.
 */
function Attachment({ message, mine }) {
  const { attachment: file, kind, pending } = message;
  // An optimistic bubble has no readable file yet; show the frame, not a broken
  // image icon.
  if (pending) {
    return (
      <div className="grid h-24 place-items-center rounded bg-black/10">
        <span className="data opacity-70">sending…</span>
      </div>
    );
  }

  const src = fileUrl(file.fileId);

  if (kind === "image") {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block">
        <img
          src={src}
          alt={file.name || "Photo"}
          loading="lazy"
          className="max-h-96 w-full rounded object-cover"
        />
      </a>
    );
  }

  if (kind === "video") {
    // A recorded note carries a duration; an attached file does not. Notes get
    // the round, compact treatment so the two read as different things.
    const isNote = !!file.durationMs;
    return (
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        className={isNote ? "size-56 max-w-full rounded-full object-cover" : "max-h-96 w-full rounded"}
      />
    );
  }

  if (kind === "audio") {
    return <VoiceNote src={src} durationMs={file.durationMs} mine={mine} />;
  }

  return (
    <a
      href={src}
      download={file.name}
      className={`flex items-center gap-3 rounded px-1 py-0.5 transition-opacity hover:opacity-80 ${
        mine ? "text-white" : "text-ink"
      }`}
    >
      <svg viewBox="0 0 20 20" className="size-7 shrink-0" aria-hidden="true">
        <path
          d="M11.5 2.5H5.5v15h9V5.5l-3-3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M11.5 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <span className="min-w-0">
        <span className="block truncate text-sm">{file.name || "File"}</span>
        <span className={`data ${mine ? "text-white/60" : "text-faint"}`}>{bytesOf(file.size)}</span>
      </span>
    </a>
  );
}

/**
 * Signature element. A deleted message leaves a censor's bar — an honest picture
 * of what the server still holds, which is a tombstone and nothing else.
 */
function Tombstone({ mine, at, showMeta }) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[min(34rem,78%)] px-3 py-2">
        <span className="censored px-2 py-0.5 text-sm" aria-label="Message deleted">
          deleted
        </span>
        {showMeta ? <p className="data mt-0.5 text-right text-faint">{clockOf(at)}</p> : null}
      </div>
    </div>
  );
}

/**
 * A voice note is a single button: play or pause, with the elapsed time shown
 * under it. The full audio element with its scrubber is overkill for a
 * hold-to-record message.
 */
function VoiceNote({ src, durationMs, mine }) {
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setPlaying(!el.paused);
      setElapsed(el.currentTime * 1000);
    };
    el.addEventListener("timeupdate", update);
    el.addEventListener("play", update);
    el.addEventListener("pause", update);
    el.addEventListener("ended", update);
    return () => {
      el.removeEventListener("timeupdate", update);
      el.removeEventListener("play", update);
      el.removeEventListener("pause", update);
      el.removeEventListener("ended", update);
      el.pause();
    };
  }, []);

  const ms = elapsed || durationMs || 0;
  const mm = Math.floor(ms / 60000);
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");

  return (
    <div className={`flex min-w-52 items-center gap-3 ${mine ? "flex-row-reverse" : ""}`}>
      <audio ref={ref} src={src} preload="metadata" onEnded={() => setPlaying(false)} />
      <button
        type="button"
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          if (el.paused) {
            void el.play();
          } else {
            el.pause();
          }
        }}
        aria-label={playing ? "Pause" : "Play"}
        className={`grid size-10 shrink-0 place-items-center rounded-full transition-colors ${
          mine ? "bg-white/20 text-white" : "bg-wire text-white"
        }`}
      >
        {playing ? (
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <rect x="5" y="3.5" width="3.2" height="13" rx="1" fill="currentColor" />
            <rect x="11.8" y="3.5" width="3.2" height="13" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <path d="M6 4.5v11l8.5-5.5L6 4.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <span className="data tabular-nums text-faint">
        {mm}:{ss}
      </span>
    </div>
  );
}

/** One tick sent, two delivered, two filled read. */
function Receipt({ message }) {
  const state = message.pending ? "pending" : message.readAt ? "read" : message.deliveredAt ? "delivered" : "sent";
  const label = { pending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read" }[state];

  if (state === "pending") {
    return (
      <svg viewBox="0 0 14 14" className="size-3.5" aria-label={label} role="img">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".5" />
        <path d="M7 4v3.4l2.2 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 18 14"
      className="size-4"
      aria-label={label}
      role="img"
      // Read ticks go solid white against the blue bubble; delivered stay muted.
      style={{ color: state === "read" ? "#fff" : "currentColor" }}
    >
      <path
        d="M1.5 8.2 4.3 11l5.4-6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {state !== "sent" ? (
        <path
          d="M7.3 8.2 10.1 11l5.4-6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}
