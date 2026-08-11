import { useEffect, useState } from "react";
import { api } from "./lib/api.js";
import SignIn from "./screens/SignIn.jsx";
import ClaimUsername from "./screens/ClaimUsername.jsx";
import Messenger from "./screens/Messenger.jsx";

/**
 * Three states, decided by one request. `/api/me` is the only thing that knows
 * whether you're signed in and whether you have a handle yet, so routing off it
 * keeps the client from holding a second opinion.
 */
export default function App() {
  const [state, setState] = useState({ status: "loading", user: null, providers: [] });

  async function load() {
    try {
      // `providers` rides along on the same response: the door has to know which
      // buttons are real, and it would otherwise need a request of its own to
      // find out something the bootstrap already had to ask.
      const { user, providers } = await api.me();
      setState({ status: "ready", user, providers: providers ?? [] });
    } catch {
      setState({ status: "offline", user: null, providers: [] });
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (state.status === "loading") return <Booting />;

  if (state.status === "offline") {
    return (
      <Notice
        title="Can't reach the server"
        body="The API isn't answering. Check that it's running, then try again."
        action={{ label: "Retry", onClick: load }}
      />
    );
  }

  if (!state.user) return <SignIn providers={state.providers} />;
  if (!state.user.username)
    return (
      <ClaimUsername onClaimed={(user) => setState((s) => ({ ...s, status: "ready", user }))} />
    );

  return (
    <Messenger
      me={state.user}
      onSignedOut={() => setState((s) => ({ ...s, status: "ready", user: null }))}
    />
  );
}

function Booting() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ground">
      <p className="eyebrow">Connecting</p>
    </div>
  );
}

function Notice({ title, body, action }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-ink-soft">{body}</p>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-6 rounded-sm bg-wire px-4 py-2 text-sm font-medium text-white"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
