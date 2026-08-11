/**
 * Avatar, with a deterministic fallback. The tint comes from the id so the same
 * person is the same colour on every device, and the pair is drawn from the
 * airmail accents rather than a random hue.
 */
const TINTS = ["var(--c-wire)", "var(--c-post)", "var(--c-ink-soft)", "var(--c-live)"];

function tintOf(id) {
  let hash = 0;
  for (const ch of String(id ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

function initialOf(user) {
  const source = user?.displayName || user?.username || "?";
  return source.trim().charAt(0).toUpperCase();
}

export default function Avatar({ user, size = 36, showPresence = false }) {
  const deleted = user?.deleted;

  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {user?.avatarUrl && !deleted ? (
        <img
          src={user.avatarUrl}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="size-full rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid size-full place-items-center rounded-full font-display font-semibold text-white"
          style={{
            background: deleted ? "var(--c-faint)" : tintOf(user?.id),
            fontSize: size * 0.42,
          }}
        >
          {deleted ? "·" : initialOf(user)}
        </span>
      )}

      {showPresence && user?.online ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-surface bg-live"
          style={{ width: size * 0.3, height: size * 0.3 }}
          title="Online"
        />
      ) : null}
    </span>
  );
}
