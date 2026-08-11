import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

/**
 * First-run gate. The handle is a public address — you are findable by it, and
 * messages you send are signed with it — so picking it is a real decision, not
 * a prefilled form. The suggestion is a starting point, never an assignment.
 */
export default function ClaimUsername({ onClaimed }) {
  const [value, setValue] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState(null);
  const [check, setCheck] = useState(null); // { available, reason }
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const suggest = params.get("suggest");
    if (suggest) {
      setValue(suggest);
      setSuggestion(suggest);
    }
    params.delete("suggest");
    params.delete("signedin");
    history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
    inputRef.current?.focus();
  }, []);

  // Availability is a server opinion, not a client regex — the claim itself
  // re-checks, and this just makes the form livable. Debounced, and only after
  // a candidate with the right shape exists.
  useEffect(() => {
    if (!/^[a-z0-9_]{3,20}$/.test(value)) return setCheck(null);
    const t = setTimeout(async () => {
      try {
        setCheck(await api.checkUsername(value));
      } catch {
        setCheck(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [value]);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const { user } = await api.claimUsername(value);
      onClaimed(user);
    } catch (err) {
      setError(
        err.code === "taken" || err.code === "reserved"
          ? "That handle is taken. Try another."
          : err.code === "cooldown"
            ? "You changed it recently — pick a different one for now."
            : err.code === "slow_down"
              ? "Steady — give it a moment and try again."
              : "Something went wrong. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  const valid = /^[a-z0-9_]{3,20}$/.test(value);

  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-5 py-10">
      <form onSubmit={submit} className="w-full max-w-sm">
        <p className="eyebrow">First things first</p>
        <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-tight">Claim your handle</h1>
        <p className="mt-3 text-ink-soft">
          Your handle is how people find and address you — 3–20 lowercase letters, digits, and underscores.
          You can change it, but only once every 30 days.
        </p>

        <div className="mt-7">
          <div className="relative">
            <span className="data absolute inset-y-0 left-3 flex items-center text-faint">@</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => {
                // A suggestion's only power is as a starting point; once you've
                // edited past it, it stops being offered.
                if (suggestion && value !== suggestion) setSuggestion("");
              }}
              placeholder="choose a handle"
              maxLength={20}
              spellCheck={false}
              autoCapitalize="none"
              className="data w-full rounded-sm border border-line bg-raised py-3 pr-4 pl-8 outline-none placeholder:text-faint focus:border-wire"
            />
          </div>

          {check?.available ? (
            <p className="data mt-2 text-live">@{value} is free</p>
          ) : check ? (
            <p className="data mt-2 text-post">
              {check.reason === "bad_username"
                ? "3–20 chars, lowercase letters, digits, underscores."
                : "That handle is taken."}
            </p>
          ) : null}

          {suggestion ? (
            <p className="mt-4 rounded-sm border-l-2 border-wire bg-surface px-3 py-2 text-sm text-ink-soft">
              From your GitHub profile, we thought of{" "}
              <button
                type="button"
                className="data font-medium text-wire underline decoration-wire/40 underline-offset-2"
                onClick={() => setValue(suggestion)}
              >
                @{suggestion}
              </button>{" "}
              — yours if you want it.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 border-l-2 border-post pl-3 text-sm text-ink-soft">
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!valid || saving}
          className="mt-6 w-full rounded-sm bg-wire px-4 py-3 font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Claiming…" : "Claim it"}
        </button>
      </form>
    </main>
  );
}
