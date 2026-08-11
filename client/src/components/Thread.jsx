import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dayLabelOf, lastSeenOf, sameDay } from "../lib/format.js";
import Avatar from "./Avatar.jsx";
import MessageBubble from "./MessageBubble.jsx";
import Composer from "./Composer.jsx";
import Modal, { Choice, DangerButton, ModalActions } from "./Modal.jsx";

export default function Thread({
  me,
  conversation,
  messages,
  hasMore,
  hasNewer,
  highlightId,
  peerTyping,
  onBack,
  onSend,
  onTyping,
  onLoadOlder,
  onReturnToLatest,
  onDeleteMessage,
  onDeleteConversation,
  onDismiss,
}) {
  const scrollerRef = useRef(null);
  const bottomRef = useRef(null);
  const targetRef = useRef(null);
  const [pinned, setPinned] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [confirming, setConfirming] = useState(null); // { kind: "message", message } | { kind: "conversation" }
  const [menuOpen, setMenuOpen] = useState(false);

  // Only auto-scroll when the reader is already at the bottom. Yanking someone
  // out of history they're reading is worse than missing a new message — and a
  // window opened on a search result is never at the bottom by definition.
  useEffect(() => {
    if (pinned && !highlightId) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, peerTyping, pinned, highlightId]);

  // Centre the searched-for message once its row exists. `layout` rather than a
  // plain effect so it lands before paint, with no visible jump from the bottom.
  useLayoutEffect(() => {
    if (!highlightId) return;
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [highlightId, messages]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  // Prepending older messages would jump the viewport, so hold the distance from
  // the bottom across the render instead of the scrollTop.
  const anchor = useRef(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || anchor.current == null) return;
    el.scrollTop = el.scrollHeight - anchor.current;
    anchor.current = null;
  }, [messages]);

  async function loadOlder() {
    const el = scrollerRef.current;
    if (!el || loadingOlder) return;
    setLoadingOlder(true);
    anchor.current = el.scrollHeight - el.scrollTop;
    try {
      await onLoadOlder(conversation.id);
    } finally {
      setLoadingOlder(false);
    }
  }

  const { peer } = conversation;

  return (
    <>
      <header className="relative border-b border-line bg-surface px-3 py-3 md:px-5">
        <div className="airmail-edge absolute inset-x-0 top-0 h-[3px]" />
        <div className="flex items-center gap-3">
          {/* Below md the thread has replaced the list, so this is the only way
              back to it. Hidden from md up, where both panes are on screen and
              a back arrow would point at something already visible. */}
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-sm text-faint hover:bg-raised hover:text-ink md:hidden"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
              <path
                d="M12.5 4 6.5 10l6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <Avatar user={peer} size={38} showPresence />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{peer?.displayName ?? "Unknown"}</p>
            <p className="data truncate text-faint">
              {peer?.deleted ? (
                "account deleted"
              ) : (
                <>
                  @{peer?.username} ·{" "}
                  {peerTyping ? (
                    <span className="text-wire">typing…</span>
                  ) : peer?.online ? (
                    <span className="text-live">online</span>
                  ) : (
                    lastSeenOf(peer?.lastSeenAt)
                  )}
                </>
              )}
            </p>
          </div>
          <ThreadMenu
            open={menuOpen}
            setOpen={setMenuOpen}
            onDelete={() => setConfirming({ kind: "conversation" })}
          />
        </div>
      </header>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5"
      >
        {/* The only account this reader gets of where their history went, so it
            waits to be acknowledged rather than fading on its own. */}
        {conversation.closedByPeer ? (
          <div className="mx-auto mb-4 max-w-md rounded-sm border-l-2 border-post bg-surface px-3 py-2 text-center">
            <p className="text-sm text-ink-soft">
              {peer?.displayName ?? "They"} deleted this conversation for both of you. What was here is gone.
            </p>
            <button
              type="button"
              onClick={() => onDismiss(conversation.id)}
              className="eyebrow mt-1.5 hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {hasMore ? (
          <div className="mb-4 text-center">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="eyebrow rounded-sm border border-line px-3 py-1.5 hover:border-wire hover:text-ink disabled:opacity-50"
            >
              {loadingOlder ? "Loading" : "Earlier messages"}
            </button>
          </div>
        ) : null}

        {messages === null ? (
          <p className="eyebrow py-8 text-center">Loading</p>
        ) : messages.length === 0 ? (
          <FirstMessage peer={peer} />
        ) : (
          <ol className="space-y-1">
            {messages.map((message, i) => {
              const previous = messages[i - 1];
              const newDay = !previous || !sameDay(previous.at, message.at);
              // Consecutive messages from the same person within 4 minutes read
              // as one utterance, so only the last of a run carries a timestamp.
              const next = messages[i + 1];
              const endsRun =
                !next ||
                next.from !== message.from ||
                new Date(next.at) - new Date(message.at) > 240_000;

              return (
                <li key={message.id} ref={message.id === highlightId ? targetRef : null}>
                  {newDay ? (
                    <p className="eyebrow py-4 text-center">{dayLabelOf(message.at)}</p>
                  ) : null}
                  <MessageBubble
                    message={message}
                    mine={message.from === me.id}
                    showMeta={endsRun}
                    found={message.id === highlightId}
                    onDelete={(m) => setConfirming({ kind: "message", message: m })}
                  />
                </li>
              );
            })}
          </ol>
        )}

        {peerTyping ? <TypingRow peer={peer} /> : null}
        <div ref={bottomRef} />
      </div>

      {/* A window opened on a search result may sit far above the live end, so
          the button has to refetch rather than merely scroll — scrolling to the
          bottom of a window lands in the middle of the thread. */}
      {!pinned || hasNewer ? (
        <button
          type="button"
          onClick={async () => {
            if (hasNewer) await onReturnToLatest(conversation.id).catch(() => {});
            setPinned(true);
            bottomRef.current?.scrollIntoView({ behavior: hasNewer ? "auto" : "smooth", block: "end" });
          }}
          className="data absolute right-6 bottom-24 rounded-full border border-line bg-raised px-3 py-1.5 shadow-md hover:border-wire max-md:right-3 max-md:bottom-20"
        >
          ↓ {hasNewer ? "Back to latest" : "Latest"}
        </button>
      ) : null}

      <Composer
        conversationId={conversation.id}
        peerName={peer?.displayName}
        disabled={peer?.deleted}
        onSend={onSend}
        onTyping={onTyping}
      />

      {confirming?.kind === "message" ? (
        <ConfirmMessageDelete
          message={confirming.message}
          peerName={peer?.displayName}
          onClose={() => setConfirming(null)}
          onConfirm={() => onDeleteMessage(conversation.id, confirming.message.id)}
        />
      ) : null}

      {confirming?.kind === "conversation" ? (
        <ConfirmConversationDelete
          peerName={peer?.displayName ?? "them"}
          onClose={() => setConfirming(null)}
          onConfirm={(scope) => onDeleteConversation(conversation.id, scope)}
        />
      ) : null}
    </>
  );
}

function ThreadMenu({ open, setOpen, onDelete }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Conversation options"
        aria-expanded={open}
        className="grid size-8 place-items-center rounded-sm text-faint hover:bg-raised hover:text-ink"
      >
        <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
          <circle cx="10" cy="4.5" r="1.4" fill="currentColor" />
          <circle cx="10" cy="10" r="1.4" fill="currentColor" />
          <circle cx="10" cy="15.5" r="1.4" fill="currentColor" />
        </svg>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-sm border border-line bg-raised shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-post hover:bg-surface"
          >
            Delete conversation…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One message, for everyone, with no time limit — so the dialog says what
 * survives rather than implying the message never existed. It leaves a marker in
 * both timelines, and that is the honest description of a tombstone.
 */
function ConfirmMessageDelete({ message, peerName, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch {
      setBusy(false);
      setError("That didn't go through. The message is still there.");
    }
  }

  return (
    <Modal title="Delete this message?" onClose={onClose}>
      <p className="mt-2 text-sm text-ink-soft">
        It goes for you and for {peerName ?? "them"}. Both of you keep a marker where it was, so the
        conversation doesn't quietly reshuffle around the gap.
      </p>
      {message.attachment ? (
        <p className="data mt-2 text-faint">The attached file is deleted with it.</p>
      ) : null}
      {error ? <p className="data mt-2 text-post">{error}</p> : null}
      <ModalActions onCancel={onClose}>
        <DangerButton onClick={run} busy={busy} data-autofocus>
          Delete for everyone
        </DangerButton>
      </ModalActions>
    </Modal>
  );
}

/**
 * Both scopes in one dialog, side by side. Presenting them together is the point:
 * the difference between "my copy" and "both copies" is the whole decision, and a
 * menu that separates them into two entries invites picking the wrong one.
 */
function ConfirmConversationDelete({ peerName, onClose, onConfirm }) {
  const [scope, setScope] = useState("me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(scope);
      onClose();
    } catch {
      setBusy(false);
      setError("That didn't go through. Nothing was deleted.");
    }
  }

  return (
    <Modal title="Delete this conversation?" onClose={onClose}>
      <div className="mt-3 space-y-2">
        <Choice
          name="scope"
          value="me"
          checked={scope === "me"}
          onChange={setScope}
          label="Clear my copy"
          detail={`Removes it from your side only. ${peerName} keeps everything and isn't told.`}
        />
        <Choice
          name="scope"
          value="everyone"
          checked={scope === "everyone"}
          onChange={setScope}
          label="Delete for both of us"
          detail={`Destroys both copies, files included. ${peerName} sees a notice saying you did it.`}
        />
      </div>
      {error ? <p className="data mt-3 text-post">{error}</p> : null}
      <ModalActions onCancel={onClose}>
        <DangerButton onClick={run} busy={busy}>
          {scope === "everyone" ? "Delete for both" : "Clear my copy"}
        </DangerButton>
      </ModalActions>
    </Modal>
  );
}

/** A radio that takes the whole row, so the label and its consequence are one target. */

function FirstMessage({ peer }) {
  return (
    <div className="grid place-items-center py-16 text-center">
      <Avatar user={peer} size={56} />
      <p className="mt-3 font-display text-xl font-semibold">{peer?.displayName}</p>
      <p className="data text-faint">@{peer?.username}</p>
      <p className="mt-3 max-w-xs text-sm text-ink-soft">
        Nothing here yet. Whatever you send first opens the channel.
      </p>
    </div>
  );
}

function TypingRow({ peer }) {
  return (
    <div className="mt-2 flex items-center gap-2 pl-1">
      <Avatar user={peer} size={22} />
      <span className="flex gap-1" aria-label={`${peer?.displayName ?? "They"} is typing`}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-faint motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 120}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
    </div>
  );
}
