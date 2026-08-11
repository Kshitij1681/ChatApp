import { useEffect, useRef } from "react";

/**
 * The shell every destructive confirmation borrows.
 *
 * Escape and a backdrop click both cancel, because a dialog you can't back out
 * of is how people delete things they meant to keep. Focus moves inside on open
 * and returns to whatever opened it on close — without that, dismissing a dialog
 * drops keyboard focus onto the body and the reader loses their place.
 */
export default function Modal({ title, onClose, children, labelledBy = "modal-title" }) {
  const panelRef = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    // The first control, not the panel: whoever opened this is mid-keystroke and
    // should land on something they can act on.
    const focusable = panelRef.current?.querySelector(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (focusable ?? panelRef.current)?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Contain Tab inside the dialog. Otherwise the next Tab walks into the
      // thread behind it, where every button is still live.
      const items = panelRef.current?.querySelectorAll(
        "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      returnTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 px-4 backdrop-blur-[2px]"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="rise flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-md border border-line bg-surface shadow-xl outline-none"
      >
        {/* The edge is a sibling of the scroller, not inside it, so a dialog
            taller than the viewport scrolls its body and keeps its letterhead. */}
        <div className="airmail-edge h-[3px] shrink-0" />
        <div className="scroll-thin min-h-0 overflow-y-auto px-5 py-4">
          <h2 id={labelledBy} className="font-display text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The row of buttons at the foot of a dialog. Cancel first, danger last. */
export function ModalActions({ onCancel, cancelLabel = "Cancel", children }) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-sm border border-line px-3 py-1.5 text-sm hover:border-wire"
      >
        {cancelLabel}
      </button>
      {children}
    </div>
  );
}

/** Destructive submit. Carries the airmail red — the only place it means "gone". */
export function DangerButton({ busy, children, ...props }) {
  return (
    <button
      type="button"
      disabled={busy}
      className="rounded-sm bg-post px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      {...props}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

/**
 * A radio that takes the whole row, so the label and the consequence of picking
 * it are one target. Every destructive choice in this app is a pair of these:
 * the reader should be comparing outcomes, not decoding two menu entries.
 */
export function Choice({ name, value, checked, onChange, label, detail }) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-sm border p-3 transition-colors ${
        checked ? "border-wire bg-raised" : "border-line hover:border-wire/50"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1 size-4 shrink-0 accent-wire"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-sm text-ink-soft">{detail}</span>
      </span>
    </label>
  );
}
