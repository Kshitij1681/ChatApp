import { useEffect, useState } from "react";

/**
 * The door. The hero is the thing itself: a stamped airmail envelope addressed
 * to whoever is about to sign in, with the postmark landing on load.
 *
 * `providers` is the list the server actually has credentials for. Offering a
 * button for a provider that isn't configured sends people to a 503 and lets
 * them conclude the app is broken, when the truth is that this deployment only
 * does GitHub.
 */
export default function SignIn({ providers = [] }) {
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("error") === "denied") setError("That sign-in was cancelled.");
  }, []);

  const offered = PROVIDERS.filter((p) => providers.includes(p.id));

  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-5 py-10">
      <div className="w-full max-w-md">
        <Envelope />

        <div className="mt-9">
          <p className="eyebrow">Direct messages</p>
          <h1 className="mt-1.5 font-display text-[2.6rem] leading-[1.05] font-semibold tracking-tight">
            Two people,
            <br />
            one channel.
          </h1>
          <p className="mt-3 text-ink-soft">
            Sign in to claim a handle. Anyone who knows it can reach you — and nothing else about you is searchable.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-5 border-l-2 border-post pl-3 text-sm text-ink-soft">
            {error}
          </p>
        ) : null}

        {offered.length ? (
          <div className="mt-7 space-y-2.5">
            {offered.map((p) => (
              <ProviderButton key={p.id} href={`/auth/${p.id}`} label={p.label} mark={p.mark} />
            ))}
          </div>
        ) : (
          // Nobody can sign in, so say why rather than showing an empty gap. This
          // is a server that booted without OAuth credentials, and the person
          // reading it is the one who can fix it.
          <p role="alert" className="mt-7 border-l-2 border-post pl-3 text-sm text-ink-soft">
            No sign-in provider is configured on this server. Add Google or GitHub credentials to <code className="data">server/.env</code> and
            restart — the README has the steps.
          </p>
        )}

        <p className="data mt-7 text-faint">Messages are stored unencrypted — see the README for exactly what that means.</p>
      </div>
    </main>
  );
}

const PROVIDERS = [
  { id: "google", label: "Continue with Google", mark: <GoogleMark /> },
  { id: "github", label: "Continue with GitHub", mark: <GitHubMark /> },
];

/**
 * Signature element, in its origin form: the barber stripe as an actual envelope
 * border, with the postmark ring rotating into place once.
 */
function Envelope() {
  return (
    <div
      className="rise relative aspect-video w-full overflow-hidden rounded-sm bg-raised"
      style={{ boxShadow: "0 1px 0 var(--c-line), 0 12px 30px -18px var(--c-shadow)" }}
    >
      <div className="airmail-edge absolute inset-x-0 top-0 h-1.5" />
      <div className="airmail-edge absolute inset-x-0 bottom-0 h-1.5" />
      <div className="airmail-edge absolute inset-y-0 left-0 w-1.5" />
      <div className="airmail-edge absolute inset-y-0 right-0 w-1.5" />

      {/* Ruled address lines, the way a real aerogramme is pre-printed. */}
      <div className="absolute inset-x-12 top-[38%] space-y-3.5">
        <div className="h-px bg-line" />
        <div className="h-px w-4/5 bg-line" />
        <div className="h-px w-3/5 bg-line" />
      </div>

      <svg
        viewBox="0 0 100 100"
        aria-hidden="true"
        className="absolute top-4 right-4 h-16 w-16 opacity-80 animate-[postmark_700ms_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:animate-none"
        style={{ color: "var(--c-post)" }}
      >
        <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="50" cy="50" r="35" fill="none" stroke="currentColor" strokeWidth="1" />
        <text x="50" y="45" textAnchor="middle" fill="currentColor" style={{ font: "600 13px var(--font-display)", letterSpacing: "0.12em" }}>
          DIRECT
        </text>
        <text x="50" y="62" textAnchor="middle" fill="currentColor" style={{ font: "500 9px var(--font-mono)", letterSpacing: "0.08em" }}>
          1&nbsp;TO&nbsp;1
        </text>
      </svg>

      <style>{`
        @keyframes postmark {
          from { opacity: 0; transform: rotate(-14deg) scale(1.35); }
          to   { opacity: .8; transform: rotate(-7deg) scale(1); }
        }
      `}</style>
    </div>
  );
}

function ProviderButton({ href, label, mark }) {
  return (
    <a
      href={href}
      className="flex w-full items-center gap-3 rounded-sm border border-line bg-raised px-4 py-3 font-medium transition-colors hover:border-wire hover:bg-surface"
    >
      <span className="grid size-5 shrink-0 place-items-center">{mark}</span>
      {label}
    </a>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-full" aria-hidden="true">
      <path fill="#4285F4" d="M45 24c0-1.6-.15-3.14-.42-4.62H24v8.74h11.77c-.51 2.73-2.05 5.04-4.36 6.59v5.47h7.05C42.6 36.36 45 30.65 45 24z" />
      <path
        fill="#34A853"
        d="M24 46c5.67 0 10.43-1.88 13.9-5.08l-7.05-5.47c-1.95 1.31-4.44 2.09-6.85 2.09-5.27 0-9.73-3.56-11.32-8.34H5.4v5.66C8.9 41.83 15.93 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M12.68 29.2A13.2 13.2 0 0 1 12 25c0-1.46.25-2.87.68-4.2v-5.66H5.4A21.9 21.9 0 0 0 3 25c0 3.54.85 6.89 2.4 9.86l7.28-5.66z"
      />
      <path
        fill="#EA4335"
        d="M24 11.75c2.97 0 5.63 1.02 7.73 3.02l6.25-6.25C34.42 4.98 29.67 3 24 3 15.93 3 8.9 7.17 5.4 15.14l7.28 5.66C14.27 16.02 18.73 11.75 24 11.75z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-full" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .66-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
