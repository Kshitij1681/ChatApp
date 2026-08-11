import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { bytesOf } from "../lib/format.js";
import Recorder from "./Recorder.jsx";

const MAX = 4000; // matches the server's sanitizeText cap
const TYPING_THROTTLE = 2000;

/** The server owns the real limits; these only pre-empt a doomed upload. */
const CAPS = { image: 5, audio: 5, video: 25, file: 25 };

const REFUSALS = {
  unsupported_type: "That file type isn't allowed.",
  too_large: "That file is too large.",
  quota_exceeded: "You're out of storage. Delete something first.",
  storage_full: "The server is out of storage.",
  rate_limited: "Slow down a moment.",
  network: "Upload failed. Check your connection.",
};

export default function Composer({ conversationId, peerName, disabled, onSend, onTyping }) {
  const [value, setValue] = useState("");
  const [attachment, setAttachment] = useState(null); // { file, kind, progress, fileId?, error? }
  const [dragging, setDragging] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [recording, setRecording] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastTypingAt = useRef(0);
  const stopTimer = useRef(null);
  const abortRef = useRef(null);

  // Grow with the content, up to a ceiling — a composer that eats the thread is
  // worse than one that scrolls.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // Switching threads should never carry a half-written message with it.
  useEffect(() => {
    setValue("");
    setAttachment(null);
    abortRef.current?.abort();
    textareaRef.current?.focus();
  }, [conversationId]);

  useEffect(() => () => {
    clearTimeout(stopTimer.current);
    abortRef.current?.abort();
  }, []);

  function signalTyping() {
    const now = Date.now();
    if (now - lastTypingAt.current > TYPING_THROTTLE) {
      lastTypingAt.current = now;
      onTyping(conversationId, true);
    }
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      lastTypingAt.current = 0;
      onTyping(conversationId, false);
    }, 2500);
  }

  function kindOf(file) {
    const type = file.type.split(";")[0];
    if (type.startsWith("image/")) return type === "image/svg+xml" ? null : "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return "file";
  }

  /**
   * Uploads immediately on pick rather than on send. By the time someone hits
   * Enter the bytes are already there, so the message appears at once instead of
   * hanging behind a 25 MB video.
   */
  async function attach(file) {
    if (!file || disabled) return;
    const kind = kindOf(file);
    if (!kind) {
      setAttachment({ file, kind: "file", error: "SVG files aren't allowed." });
      return;
    }
    // Checked here only to fail fast with a clear number; the server decides.
    if (file.size > CAPS[kind] * 1024 * 1024) {
      setAttachment({ file, kind, error: `${kind === "image" ? "Images" : "Files"} are capped at ${CAPS[kind]} MB.` });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setAttachment({ file, kind, progress: 0 });

    try {
      const stored = await api.upload(file, {
        signal: controller.signal,
        onProgress: (p) => setAttachment((a) => (a?.file === file ? { ...a, progress: p } : a)),
      });
      setAttachment((a) => (a?.file === file ? { ...a, progress: 1, fileId: stored.fileId } : a));
    } catch (err) {
      if (err.code === "aborted") return;
      setAttachment((a) => (a?.file === file ? { ...a, error: REFUSALS[err.code] ?? "Upload failed." } : a));
    }
  }

  function clearAttachment() {
    abortRef.current?.abort();
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * A finished recording sends on its own rather than becoming a chip: the
   * gesture already said "send this", and making someone press Enter afterwards
   * would be a second confirmation nobody asked for.
   */
  async function sendRecording({ file, durationMs, mode }) {
    setRecordError("");
    setAttachment({ file, kind: mode === "video" ? "video" : "audio", progress: 0 });
    try {
      const stored = await api.upload(file, {
        onProgress: (p) => setAttachment((a) => (a?.file === file ? { ...a, progress: p } : a)),
      });
      onSend(conversationId, "", stored.fileId, {
        kind: stored.kind,
        name: stored.name,
        mime: stored.mime,
        size: stored.size,
        durationMs,
      });
      setAttachment(null);
    } catch (err) {
      if (err.code === "aborted") return;
      setAttachment(null);
      setRecordError(REFUSALS[err.code] ?? "Upload failed.");
    }
  }

  function submit() {
    const body = value.trim();
    const ready = attachment?.fileId;
    // Either a caption or a file is enough, but an upload still in flight is not.
    if (disabled || (!body && !ready)) return;
    if (attachment && !ready) return;

    onSend(conversationId, body.slice(0, MAX), ready ?? null, {
      kind: attachment?.kind,
      name: attachment?.file.name,
      mime: attachment?.file.type,
      size: attachment?.file.size,
    });
    setValue("");
    clearAttachment();
    clearTimeout(stopTimer.current);
    lastTypingAt.current = 0;
    onTyping(conversationId, false);
    textareaRef.current?.focus();
  }

  function onKeyDown(event) {
    // Enter sends, Shift+Enter breaks the line — the convention people already
    // have in their fingers.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function onPaste(event) {
    const file = [...(event.clipboardData?.files ?? [])][0];
    if (file) {
      event.preventDefault();
      attach(file);
    }
  }

  const remaining = MAX - value.length;
  const uploading = attachment && !attachment.fileId && !attachment.error;
  const canSend = !disabled && !uploading && (value.trim() || attachment?.fileId);

  return (
    <div
      className="relative border-t border-line bg-surface px-4 py-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only leave when the pointer exits the drop zone itself, not on every
        // child boundary crossing.
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files?.[0]);
      }}
    >
      {dragging ? (
        <div className="absolute inset-2 z-10 grid place-items-center rounded-md border-2 border-dashed border-wire bg-raised/95">
          <span className="data text-wire">Drop to attach</span>
        </div>
      ) : null}

      {recordError ? (
        <p className="data mb-2 text-post" role="status">
          {recordError}
        </p>
      ) : null}

      {attachment ? (
        <AttachmentChip attachment={attachment} onRemove={clearAttachment} />
      ) : null}

      <div className="relative flex items-end gap-2 rounded-md border border-line bg-raised px-3 py-2 focus-within:border-wire">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => attach(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || !!attachment}
          aria-label="Attach a file"
          className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-ground hover:text-ink disabled:opacity-30"
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <path
              d="M12.5 6.5 7 12a2.1 2.1 0 0 0 3 3l5.5-5.5a4.2 4.2 0 0 0-6-6L4 9.5a6.3 6.3 0 0 0 9 9l4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          maxLength={MAX}
          onChange={(e) => {
            setValue(e.target.value);
            signalTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={disabled ? "This account was deleted" : `Message ${peerName ?? ""}`}
          aria-label="Message"
          className="scroll-thin max-h-40 flex-1 resize-none bg-transparent leading-relaxed outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />

        {remaining < 200 ? (
          <span className={`data self-center ${remaining < 0 ? "text-post" : "text-faint"}`}>{remaining}</span>
        ) : null}

        {/* Recording replaces typing, so these hide once there's text to send. */}
        {!value.trim() && !attachment ? (
          <>
            <Recorder
              mode="audio"
              disabled={disabled}
              onRecorded={sendRecording}
              onError={setRecordError}
              onBusyChange={setRecording}
            />
            <Recorder
              mode="video"
              disabled={disabled || recording}
              onRecorded={sendRecording}
              onError={setRecordError}
            />
          </>
        ) : null}

        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-post text-white transition-opacity disabled:opacity-30"
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <path d="M2 10 18 3l-4.5 7L18 17 2 10z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** The pending file, its progress, and its refusal if it was refused. */
function AttachmentChip({ attachment, onRemove }) {
  const { file, kind, progress, fileId, error } = attachment;
  const pct = Math.round((progress ?? 0) * 100);

  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border border-line bg-raised px-3 py-2">
      <span className="data shrink-0 text-faint uppercase">{kind}</span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{file.name}</p>
        {error ? (
          <p className="data mt-0.5 text-post">{error}</p>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            {/* A determinate bar, because the byte count is known — a spinner
                would hide whether a 25 MB video is moving at all. */}
            <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-line">
              <div
                className={`h-full transition-[width] duration-200 ${fileId ? "bg-live" : "bg-wire"}`}
                style={{ width: `${fileId ? 100 : pct}%` }}
              />
            </div>
            <span className="data shrink-0 text-faint">
              {fileId ? bytesOf(file.size) : `${pct}%`}
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="grid size-6 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-ground hover:text-ink"
      >
        <svg viewBox="0 0 20 20" className="size-3.5" aria-hidden="true">
          <path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
