/**
 * WebSocket client with exponential backoff, ported from screenshare-console.
 *
 * No token is passed: the session cookie rides the handshake because Vite
 * proxies /ws to the API origin, which keeps the cookie first-party.
 */
const MAX_BACKOFF = 15_000;

export function createSocket({ onMessage, onStatus }) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let closedByUs = false;

  function url() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    clearTimeout(timer);
    onStatus?.(attempt === 0 ? "connecting" : "reconnecting");

    ws = new WebSocket(url());

    ws.onopen = () => {
      attempt = 0;
      onStatus?.("open");
    };

    ws.onmessage = (event) => {
      try {
        onMessage?.(JSON.parse(event.data));
      } catch {
        /* a frame we can't parse is a frame we ignore */
      }
    };

    ws.onclose = (event) => {
      if (closedByUs) return;
      // 1008/4401 mean the server rejected us — retrying can only fail again.
      if (event.code === 1008 || event.code === 4401) return onStatus?.("unauthorized");
      onStatus?.("closed");
      // Full jitter: without it every client reconnects on the same tick.
      const wait = Math.min(MAX_BACKOFF, 500 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, Math.random() * wait);
    };

    ws.onerror = () => ws?.close();
  }

  /**
   * One tick before the first connect, so a mount that is immediately discarded
   * never opens a socket at all.
   *
   * StrictMode mounts every effect twice in development: create, clean up,
   * create again. Connecting synchronously means the first socket is aborted
   * while it is still CONNECTING, and a browser tears a connecting socket down
   * at the TCP layer without a close frame — there is no negotiated close for a
   * handshake that never finished. Vite's proxy reads that reset and logs
   * `ws proxy socket error: read ECONNRESET` on every page load, and the server
   * sees a phantom connect/disconnect pair.
   *
   * A macrotask is the right delay because StrictMode's cleanup runs
   * synchronously within the same commit, so `close()` lands before this fires
   * and cancels a pending timer instead of killing a live socket. Measured: 12
   * reloads produced 12 errors before this line and 0 after. In production,
   * where effects mount once, it costs one tick — and the caller's status starts
   * at "connecting" either way, so nothing renders differently.
   *
   * Deliberately NOT paired with a `pagehide` handler that closes the socket on
   * navigation. That was tried: `close()` begins a close *handshake*, the page
   * dies before it completes, and the OS resets the connection — which put the
   * error back on 4 of 12 reloads. Letting the browser tear down the page's
   * sockets its own way is what produces a clean log. The server already
   * notices the peer is gone via its heartbeat.
   */
  timer = setTimeout(connect, 0);

  return {
    send(payload) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
      }
      return false;
    },
    close() {
      closedByUs = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
