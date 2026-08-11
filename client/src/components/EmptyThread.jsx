import { useState } from "react";

/** Nothing selected. The one useful thing at this moment is your own handle. */
export default function EmptyThread({ me }) {
  const [copied, setCopied] = useState(false);

  async function copyHandle() {
    try {
      await navigator.clipboard.writeText(`@${me.username}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — the handle is on screen anyway */
    }
  }

  return (
    <div className="grid flex-1 place-items-center px-6">
      <div className="max-w-xs text-center">
        <div className="relative overflow-hidden rounded-sm border border-line bg-raised px-6 py-7">
          <div className="airmail-edge absolute inset-x-0 top-0 h-1" />
          <p className="eyebrow">Your handle</p>
          <p className="data mt-1.5 text-lg text-ink">@{me.username}</p>
          <button
            type="button"
            onClick={copyHandle}
            className="eyebrow mt-4 rounded-sm border border-line px-3 py-1.5 transition-colors hover:border-wire hover:text-ink"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <p className="mt-6 text-ink-soft">
          Give it to someone to be reachable, or search a handle in the sidebar to start a conversation.
        </p>
      </div>
    </div>
  );
}
