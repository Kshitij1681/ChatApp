import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { bytesOf } from "../lib/format.js";
import Modal, { Choice, DangerButton, ModalActions } from "../components/Modal.jsx";

/**
 * Settings, as a dialog rather than a route: it is a detour from a conversation,
 * and coming back should return you to exactly the thread you left.
 */
export default function Settings({ me, onClose, onDeleted }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return <DeleteAccount me={me} onClose={() => setConfirming(false)} onDeleted={onDeleted} />;
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <p className="data mt-1 text-faint">
        @{me.username} · {me.provider}
      </p>

      <Storage />

      <section className="mt-5 border-t border-line pt-4">
        <h3 className="eyebrow">Your data</h3>
        {/* Stated where someone can act on it, not only in a README. Anyone
            choosing what to send deserves to know the storage isn't sealed. */}
        <p className="mt-1.5 text-sm text-ink-soft">
          Messages are stored as plain text. They travel encrypted, but anyone with database access
          can read them — that's the trade for search and instant sign-in on a new device.
        </p>
      </section>

      <section className="mt-4 rounded-sm border border-post/40 p-3">
        <h3 className="text-sm font-medium">Delete account</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Ends every session, releases your handle, and removes your files. What happens to messages
          you've already sent is your choice.
        </p>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-2.5 rounded-sm border border-post px-3 py-1.5 text-sm font-medium text-post hover:bg-post hover:text-white"
        >
          Delete my account…
        </button>
      </section>

      <ModalActions onCancel={onClose} cancelLabel="Done" />
    </Modal>
  );
}

/**
 * Usage against the quota. Without a visible number, a rejected upload reads as a
 * bug rather than a full drive.
 */
function Storage() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.storage().then(setData, () => setData(null));
  }, []);

  if (!data) return null;
  const pct = Math.min(100, Math.round((data.used / data.quota) * 100));

  return (
    <section className="mt-4">
      <div className="flex items-baseline justify-between">
        <h3 className="eyebrow">Storage</h3>
        <span className="data text-faint">
          {bytesOf(data.used)} of {bytesOf(data.quota)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full ${pct > 90 ? "bg-post" : "bg-wire"}`}
          style={{ width: `${Math.max(pct, data.used ? 2 : 0)}%` }}
        />
      </div>
      {data.global.full ? (
        <p className="data mt-1.5 text-post">The server is out of storage. Uploads are paused.</p>
      ) : null}
    </section>
  );
}

/**
 * The account-deletion dialog.
 *
 * Anonymize is the default because a conversation is jointly authored — erasing
 * your half tears holes in a record the other person was also part of. Purge
 * stays available for anyone who genuinely means it, but it has to be chosen.
 *
 * Typing your own handle is the gate. It's the one confirmation a mis-click or a
 * cross-site POST can't produce.
 */
function DeleteAccount({ me, onClose, onDeleted }) {
  const [mode, setMode] = useState("anonymize");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const matches = typed.trim().replace(/^@/, "").toLowerCase() === me.username;

  async function run() {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(me.username, mode);
      onDeleted();
    } catch (err) {
      setBusy(false);
      setError(
        err.code === "confirm_username"
          ? "That handle doesn't match."
          : "That didn't go through. Your account is untouched.",
      );
    }
  }

  return (
    <Modal title="Delete your account" onClose={onClose}>
      <p className="mt-2 text-sm text-ink-soft">
        This can't be undone. @{me.username} is retired permanently — nobody can claim it later and
        become you in someone's history.
      </p>

      <div className="mt-3 space-y-2">
        <Choice
          name="mode"
          value="anonymize"
          checked={mode === "anonymize"}
          onChange={setMode}
          label="Leave my messages behind"
          detail="They stay in other people's threads, attributed to “Deleted user”."
        />
        <Choice
          name="mode"
          value="purge"
          checked={mode === "purge"}
          onChange={setMode}
          label="Erase every message I sent"
          detail="Removed from other people's threads too, leaving gaps in conversations they were part of."
        />
      </div>

      <label className="mt-4 block">
        <span className="eyebrow">Type @{me.username} to confirm</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && matches && run()}
          placeholder={`@${me.username}`}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          className="data mt-1 w-full rounded-sm border border-line bg-raised px-3 py-2 outline-none placeholder:text-faint focus:border-post"
        />
      </label>

      {error ? <p className="data mt-2 text-post">{error}</p> : null}

      <ModalActions onCancel={onClose} cancelLabel="Keep my account">
        <DangerButton onClick={run} busy={busy} disabled={!matches || busy}>
          {mode === "purge" ? "Delete and erase" : "Delete account"}
        </DangerButton>
      </ModalActions>
    </Modal>
  );
}
