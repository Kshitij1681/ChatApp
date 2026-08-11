/**
 * Protocol suite. Plain node:assert, self-spawning server — same idiom as
 * screenshare-console. Runs against a real mongod, because the behaviour under
 * test (unique indexes, E11000 races, text search) is the database's, not ours.
 *
 *   node server/protocol.test.js
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9411;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://localhost:${PORT}`;
const DB = "chatapp_test";
const URI = `mongodb://127.0.0.1:27017/${DB}`;
const SECRET = "suite-secret";

let child;

/**
 * The environment the suite's own server runs in. Tests that need a different
 * configuration override individual keys and spawn a server of their own.
 */
const SERVER_ENV = {
  NODE_ENV: "test",
  PORT: String(PORT),
  MONGODB_URI: URI,
  SESSION_SECRET: "suite-session-secret",
  CLIENT_ORIGIN: ORIGIN,
  ALLOWED_ORIGINS: ORIGIN,
  ALLOW_TEST_LOGIN: "1",
  TEST_LOGIN_SECRET: SECRET,
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
};

function spawnServer(overrides = {}) {
  return spawn(process.execPath, [path.join(here, "index.js")], {
    env: { ...process.env, ...SERVER_ENV, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolves when the server announces it is listening; rejects if it dies first. */
function listening(proc, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in ${ms}ms`)), ms);
    proc.stdout.on("data", (b) => {
      if (String(b).includes("http + ws on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})`));
    });
  });
}

before(async () => {
  // A test run must never inherit state from the last one.
  const client = await new MongoClient(URI).connect();
  await client.db(DB).dropDatabase();
  await client.close();

  child = spawnServer();
  child.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));
  await listening(child);
});

after(() => {
  child?.kill();
});

/** A signed-in actor: its cookie, and helpers that carry it. */
async function signIn(username) {
  const res = await fetch(`${BASE}/auth/test-login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-secret": SECRET },
    body: JSON.stringify({ username, displayName: username }),
  });
  assert.equal(res.status, 200, `test-login failed for ${username}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { id } = await res.json();

  const call = async (method, url, body) => {
    const r = await fetch(`${BASE}${url}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };

  const upload = async (bytes, name, mime) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), name);
    const r = await fetch(`${BASE}/api/uploads`, { method: "POST", headers: { cookie }, body: form });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const fetchFile = (fileId, headers = {}) =>
    fetch(`${BASE}/api/files/${fileId}`, { headers: { cookie, ...headers } });

  return { username, id, cookie, call, upload, fetchFile };
}

/** A real 1x1 PNG, so upload tests exercise bytes we did not merely label. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Opens a socket and buffers frames so a test can await one by type. */
function connect(cookie, { origin = ORIGIN } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, origin } });
  const seen = [];
  const waiters = [];
  const listeners = [];

  ws.on("message", (raw) => {
    const frame = JSON.parse(raw);
    seen.push(frame);
    for (const l of listeners) l(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    open: () =>
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`http_${res.statusCode}`)));
      }),
    send: (payload) => ws.send(JSON.stringify(payload)),
    // Checks frames already buffered before waiting, so a fast server can't
    // deliver the frame between the send and the await.
    wait: (match, ms = 5000) =>
      new Promise((resolve, reject) => {
        const hit = seen.find(match);
        if (hit) return resolve(hit);
        const timer = setTimeout(
          // An unexpected `error` frame is the usual reason a wait fails, so
          // name what did arrive — a bare timeout hides the real cause.
          () =>
            reject(
              new Error(
                `timed out waiting for frame; saw: ${JSON.stringify(
                  seen.map((f) => (f.error ? `${f.type}(${f.error})` : f.type)),
                )}`,
              ),
            ),
          ms,
        );
        waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      }),
    // Frames from this point forward only. `wait` deliberately re-checks the
    // buffer, which is wrong for asserting that nothing *new* arrives.
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

const typeIs = (t) => (f) => f.type === t;

test("healthz answers", async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("test-login demands its shared secret", async () => {
  const res = await fetch(`${BASE}/auth/test-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nobody" }),
  });
  assert.equal(res.status, 403);
});

test("the test-login backdoor does not exist when its flag is off", async () => {
  // Worth a whole second server process. The route is mounted at import time, so
  // its absence can only be observed in a process that booted without the flag —
  // and this is the one defect in the codebase that would be a total auth bypass
  // rather than a bug. "We remembered to check an env var" is exactly the sort of
  // thing a refactor quietly undoes.
  const port = PORT + 1;
  const proc = spawnServer({ PORT: String(port), ALLOW_TEST_LOGIN: "", TEST_LOGIN_SECRET: "" });
  try {
    await listening(proc);
    const res = await fetch(`http://127.0.0.1:${port}/auth/test-login`, {
      method: "POST",
      // With the correct secret, so a pass can only mean the route is absent
      // rather than merely guarded.
      headers: { "content-type": "application/json", "x-test-secret": SECRET },
      body: JSON.stringify({ username: "ghost" }),
    });
    assert.equal(res.status, 404, "the backdoor must not answer at all, secret or no secret");
  } finally {
    proc.kill();
  }
});

test("the server refuses to boot with the backdoor enabled in production", async () => {
  // The guard has to crash rather than warn, because a warning in a log nobody
  // reads is precisely how this ships. Asserting on the exit code is asserting
  // that the deploy fails loudly instead of coming up with the door open.
  const proc = spawnServer({ NODE_ENV: "production", ALLOW_TEST_LOGIN: "1", PORT: String(PORT + 2) });
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b));

  const code = await new Promise((resolve) => proc.on("exit", resolve));
  assert.equal(code, 1, "an auth bypass in production must kill the process");
  assert.match(stderr, /auth bypass/i, "and say why, so the failed deploy is self-explaining");
});

test("the door is only offered the providers that are actually configured", async () => {
  // This suite's server boots with every OAuth credential blank, so the honest
  // answer here is an empty list. The client renders one button per entry, and
  // the failure this pins is a silent one: offer a provider with no strategy
  // behind it and the button leads to a 503 that reads, to whoever clicked it,
  // as "this app is broken" rather than "that provider isn't set up here".
  const res = await fetch(`${BASE}/api/me`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.providers, [], "no credentials means no buttons");
  assert.equal(body.user, null);
});

test("a configured provider is offered, an unconfigured one is not", async () => {
  // Needs its own process: strategies are registered at boot from env, so the
  // only way to observe a half-configured server is to boot one. GitHub gets
  // credentials, Google doesn't, and the door has to tell them apart — the
  // whole point of the field is that a GitHub-only deployment stops advertising
  // a Google button that dead-ends.
  const port = PORT + 3;
  const proc = spawnServer({
    PORT: String(port),
    GITHUB_CLIENT_ID: "gh-test-id",
    GITHUB_CLIENT_SECRET: "gh-test-secret",
  });
  try {
    await listening(proc);
    const res = await fetch(`http://127.0.0.1:${port}/api/me`);
    const body = await res.json();
    assert.deepEqual(body.providers, ["github"], "exactly the provider that has credentials");
  } finally {
    proc.kill();
  }
});

test("REST rejects the unauthenticated", async () => {
  const res = await fetch(`${BASE}/api/conversations`);
  assert.equal(res.status, 401);
});

test("upgrade without a session is refused", async () => {
  const socket = connect("");
  await assert.rejects(socket.open(), /401/);
});

test("upgrade from a disallowed origin is refused", async () => {
  const alice = await signIn("alice_o");
  // Browsers do not apply CORS to WebSocket handshakes, so this check is the
  // only thing standing between a stranger's page and an authenticated socket.
  const socket = connect(alice.cookie, { origin: "http://evil.example" });
  await assert.rejects(socket.open(), /403/);
});

test("a message crosses between two users and persists", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");

  const aliceWs = connect(alice.cookie);
  const bobWs = connect(bob.cookie);
  await Promise.all([aliceWs.open(), bobWs.open()]);
  await Promise.all([aliceWs.wait(typeIs("hello")), bobWs.wait(typeIs("hello"))]);

  const opened = await alice.call("POST", "/api/conversations", { username: "bob" });
  assert.equal(opened.status, 201);
  const convoId = opened.body.conversation.id;

  aliceWs.send({ type: "msg:send", conversationId: convoId, body: "hello over the wire", clientId: "c1" });

  const received = await bobWs.wait(typeIs("msg:new"));
  assert.equal(received.message.body, "hello over the wire");
  assert.equal(received.message.from, alice.id);

  const echoed = await aliceWs.wait((f) => f.type === "msg:new" && f.clientId === "c1");
  assert.equal(echoed.message.id, received.message.id, "both sides must agree on the id");

  // Survives the socket: it is in the database, not just in flight.
  const page = await bob.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.at(-1).body, "hello over the wire");

  aliceWs.close();
  bobWs.close();
});

test("a non-participant cannot read the thread", async () => {
  const alice = await signIn("alice");
  const mallory = await signIn("mallory");

  const { body } = await alice.call("POST", "/api/conversations", { username: "bob" });
  const res = await mallory.call("GET", `/api/conversations/${body.conversation.id}/messages`);
  assert.equal(res.status, 404, "an outsider must not be able to read, or to confirm it exists");
});

test("the sender is the session, never the payload", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const { body } = await alice.call("POST", "/api/conversations", { username: "bob" });
  const convoId = body.conversation.id;

  const aliceWs = connect(alice.cookie);
  await aliceWs.open();
  await aliceWs.wait(typeIs("hello"));

  // Claiming to be Bob must change nothing about who the server thinks we are.
  aliceWs.send({ type: "msg:send", conversationId: convoId, from: bob.id, body: "forged", clientId: "f1" });
  const echo = await aliceWs.wait((f) => f.type === "msg:new" && f.clientId === "f1");
  assert.equal(echo.message.from, alice.id);

  aliceWs.close();
});

test("an offline recipient is marked delivered only once they connect", async () => {
  const carol = await signIn("carol");
  const dave = await signIn("dave");
  const { body } = await carol.call("POST", "/api/conversations", { username: "dave" });
  const convoId = body.conversation.id;

  const carolWs = connect(carol.cookie);
  await carolWs.open();
  await carolWs.wait(typeIs("hello"));

  // Dave has no socket, so this must not claim to be delivered.
  carolWs.send({ type: "msg:send", conversationId: convoId, body: "are you there", clientId: "d1" });
  const echo = await carolWs.wait((f) => f.type === "msg:new" && f.clientId === "d1");
  assert.equal(echo.message.deliveredAt, null, "cannot be delivered to someone with no connection");

  // Dave opens his laptop. The stamp is the connection's job — nothing here
  // reads the thread, so a `deliveredAt` that only ever gets set by `msg:read`
  // would leave Carol on one tick forever.
  const daveWs = connect(dave.cookie);
  await daveWs.open();
  await daveWs.wait(typeIs("hello"));

  const receipt = await carolWs.wait((f) => f.type === "msg:status" && f.status === "delivered");
  assert.equal(receipt.conversationId, convoId);

  const page = await carol.call("GET", `/api/conversations/${convoId}/messages`);
  assert.ok(page.body.messages.at(-1).deliveredAt, "and it is persisted, not just announced");

  carolWs.close();
  daveWs.close();
});

test("the delivery flush fires once, not on every reconnect", async () => {
  const carol = await signIn("carol");
  const dave = await signIn("dave");
  const { body } = await carol.call("POST", "/api/conversations", { username: "dave" });
  const convoId = body.conversation.id;

  const carolWs = connect(carol.cookie);
  await carolWs.open();
  await carolWs.wait(typeIs("hello"));

  carolWs.send({ type: "msg:send", conversationId: convoId, body: "first", clientId: "r1" });
  await carolWs.wait((f) => f.type === "msg:new" && f.clientId === "r1");

  // First connection drains the backlog.
  const first = connect(dave.cookie);
  await first.open();
  await first.wait(typeIs("hello"));
  await carolWs.wait((f) => f.type === "msg:status" && f.status === "delivered");
  first.close();

  // Second one must find nothing to do. `modifiedCount` is what decides that,
  // so a flush that announced unconditionally would re-notify Carol here — and
  // a client that re-renders on every receipt would flicker the ticks on each
  // of Dave's reconnects, which on a flaky train connection is constant.
  const seen = [];
  carolWs.on((f) => {
    if (f.type === "msg:status") seen.push(f);
  });

  const second = connect(dave.cookie);
  await second.open();
  await second.wait(typeIs("hello"));

  // No frame to wait for, so wait for one to fail to arrive.
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(seen, [], "an empty backlog is silent");

  second.close();
  carolWs.close();
});

test("unread counts exclude your own messages", async () => {
  const erin = await signIn("erin");
  const frank = await signIn("frank");
  const { body } = await erin.call("POST", "/api/conversations", { username: "frank" });
  const convoId = body.conversation.id;

  const erinWs = connect(erin.cookie);
  await erinWs.open();
  await erinWs.wait(typeIs("hello"));
  erinWs.send({ type: "msg:send", conversationId: convoId, body: "one", clientId: "u1" });
  await erinWs.wait((f) => f.type === "msg:new" && f.clientId === "u1");

  const mine = await erin.call("GET", "/api/conversations");
  assert.equal(mine.body.conversations.find((c) => c.id === convoId).unread, 0);

  const theirs = await frank.call("GET", "/api/conversations");
  assert.equal(theirs.body.conversations.find((c) => c.id === convoId).unread, 1);

  erinWs.close();
});

test("A→B and B→A are the same conversation", async () => {
  const grace = await signIn("grace");
  const heidi = await signIn("heidi");

  const first = await grace.call("POST", "/api/conversations", { username: "heidi" });
  const second = await heidi.call("POST", "/api/conversations", { username: "grace" });
  assert.equal(first.body.conversation.id, second.body.conversation.id);
});

test("cursor pagination returns no duplicates when a message lands mid-scroll", async () => {
  const ivan = await signIn("ivan");
  const judy = await signIn("judy");
  const { body } = await ivan.call("POST", "/api/conversations", { username: "judy" });
  const convoId = body.conversation.id;

  const ivanWs = connect(ivan.cookie);
  await ivanWs.open();
  await ivanWs.wait(typeIs("hello"));

  // 8 messages + the interrupting one stays inside the 12-token burst that
  // allowMessage() grants. Bursting past it is a separate test's business; here
  // a rate-limited send would look like a pagination failure.
  for (let i = 0; i < 8; i++) {
    ivanWs.send({ type: "msg:send", conversationId: convoId, body: `m${i}`, clientId: `p${i}` });
    await ivanWs.wait((f) => f.type === "msg:new" && f.clientId === `p${i}`);
  }

  const first = await judy.call("GET", `/api/conversations/${convoId}/messages?limit=5`);
  assert.equal(first.body.hasMore, true);

  // A new message arriving between pages is exactly what breaks skip/limit.
  ivanWs.send({ type: "msg:send", conversationId: convoId, body: "interrupting", clientId: "px" });
  await ivanWs.wait((f) => f.type === "msg:new" && f.clientId === "px");

  const second = await judy.call(
    "GET",
    `/api/conversations/${convoId}/messages?limit=5&before=${first.body.nextCursor}`,
  );

  const ids = [...first.body.messages, ...second.body.messages].map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "a page boundary must not repeat a message");

  ivanWs.close();
});

test("search finds a handle and never leaks an email", async () => {
  await signIn("searchable_kim");
  const seeker = await signIn("seeker");

  const res = await seeker.call("GET", "/api/users/search?q=searchable");
  assert.equal(res.status, 200);
  const hit = res.body.users.find((u) => u.username === "searchable_kim");
  assert.ok(hit, "the handle should be findable");
  assert.equal(hit.email, undefined, "an email must never appear in a search result");

  // The address exists on the account, so searching it proves it is not indexed.
  const byEmail = await seeker.call("GET", "/api/users/search?q=searchable_kim@test.invalid");
  assert.equal(byEmail.body.users.length, 0, "email must not be a search key");
});

test("you cannot find yourself, and cannot message yourself", async () => {
  const solo = await signIn("solo");
  const search = await solo.call("GET", "/api/users/search?q=solo");
  assert.equal(search.body.users.find((u) => u.username === "solo"), undefined);

  const res = await solo.call("POST", "/api/conversations", { username: "solo" });
  assert.equal(res.status, 400);
});

test("a taken handle is refused", async () => {
  await signIn("taken_one");
  const other = await signIn("other_one");
  const res = await other.call("POST", "/api/me/username", { username: "taken_one" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "taken");
});

test("a malformed handle is refused", async () => {
  const user = await signIn("shapes");
  for (const bad of ["ab", "Has Capitals", "way_too_long_a_username_here", "sym!bols"]) {
    const res = await user.call("POST", "/api/me/username", { username: bad });
    assert.equal(res.status, 400, `${bad} should be rejected`);
  }
});

test("changing a handle reserves the old one and starts the cooldown", async () => {
  const user = await signIn("first_name");

  const changed = await user.call("POST", "/api/me/username", { username: "second_name" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.username, "second_name");

  // The old handle is parked, so nobody can inherit an identity from history.
  const squatter = await signIn("squatter");
  const grab = await squatter.call("POST", "/api/me/username", { username: "first_name" });
  assert.equal(grab.status, 409);
  assert.equal(grab.body.error, "reserved");

  // And you cannot change again inside 30 days.
  const again = await user.call("POST", "/api/me/username", { username: "third_name" });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, "cooldown");
});

test("an oversized frame is rejected, not parsed", async () => {
  const user = await signIn("frames");
  const socket = connect(user.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));

  socket.ws.send(JSON.stringify({ type: "msg:send", body: "x".repeat(10_000) }));
  const err = await socket.wait(typeIs("error"));
  assert.equal(err.error, "frame_too_large");

  socket.close();
});

test("a flood is rate limited, and the sender learns which message died", async () => {
  const nina = await signIn("nina");
  await signIn("oscar");
  const { body } = await nina.call("POST", "/api/conversations", { username: "oscar" });
  const convoId = body.conversation.id;

  const ninaWs = connect(nina.cookie);
  await ninaWs.open();
  await ninaWs.wait(typeIs("hello"));

  // The bucket holds 12. Firing 16 with no pause must trip it — a client that
  // can spend tokens faster than they refill has no ceiling at all.
  for (let i = 0; i < 16; i++) {
    ninaWs.send({ type: "msg:send", conversationId: convoId, body: `flood${i}`, clientId: `x${i}` });
  }

  const err = await ninaWs.wait((f) => f.type === "error" && f.error === "rate_limited");
  // The clientId is the point: without it the sender knows *a* message was
  // refused but not which, and its optimistic bubble spins forever.
  assert.match(err.clientId ?? "", /^x\d+$/, "a rejection must name the message it rejected");

  ninaWs.close();
});

test("an SVG is refused, whatever it claims to be", async () => {
  const user = await signIn("svg_probe");
  // SVG is a document that can carry <script>. Served same-origin it would run
  // with the session, and no sanitizer here is worth trusting — so it is simply
  // not in the allowlist.
  const res = await user.upload(
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    "payload.svg",
    "image/svg+xml",
  );
  assert.equal(res.status, 415);
  assert.equal(res.body.error, "unsupported_type");
});

test("an oversized image is refused with its limit", async () => {
  const user = await signIn("fat_upload");
  const res = await user.upload(Buffer.alloc(6 * 1024 * 1024), "big.png", "image/png");
  assert.equal(res.status, 413);
  // The limit is in the response so the client can say "5 MB", not "too big".
  assert.equal(res.body.limit, 5 * 1024 * 1024);
});

test("an attachment reaches the other participant and nobody else", async () => {
  const pia = await signIn("pia");
  const quinn = await signIn("quinn");
  const rex = await signIn("rex");
  const { body } = await pia.call("POST", "/api/conversations", { username: "quinn" });
  const convoId = body.conversation.id;

  const up = await pia.upload(PNG_1X1, "photo.png", "image/png");
  assert.equal(up.status, 201);
  assert.equal(up.body.file.kind, "image");
  const { fileId } = up.body.file;

  const piaWs = connect(pia.cookie);
  await piaWs.open();
  await piaWs.wait(typeIs("hello"));

  piaWs.send({ type: "msg:send", conversationId: convoId, fileId, body: "look", clientId: "att1" });
  const echo = await piaWs.wait((f) => f.type === "msg:new" && f.clientId === "att1");
  assert.equal(echo.message.kind, "image", "the kind comes from the stored file, not the client");
  assert.equal(echo.message.attachment.name, "photo.png");

  // The recipient can read the bytes.
  const asQuinn = await quinn.fetchFile(fileId);
  assert.equal(asQuinn.status, 200);
  assert.equal(asQuinn.headers.get("content-type"), "image/png");
  assert.equal(asQuinn.headers.get("x-content-type-options"), "nosniff");

  // An outsider cannot — and gets the same 404 as a missing file, so the route
  // never becomes an oracle for which ids exist.
  assert.equal((await rex.fetchFile(fileId)).status, 404);

  piaWs.close();
});

test("one file belongs to one message", async () => {
  const sam = await signIn("sam");
  await signIn("tara");
  const { body } = await sam.call("POST", "/api/conversations", { username: "tara" });
  const convoId = body.conversation.id;

  const { body: up } = await sam.upload(PNG_1X1, "once.png", "image/png");
  const socket = connect(sam.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));

  socket.send({ type: "msg:send", conversationId: convoId, fileId: up.file.fileId, clientId: "r1" });
  await socket.wait((f) => f.type === "msg:new" && f.clientId === "r1");

  // Reusing an id across messages would mean deleting either one destroys the
  // other's bytes, so the second attach must be refused.
  socket.send({ type: "msg:send", conversationId: convoId, fileId: up.file.fileId, clientId: "r2" });
  const err = await socket.wait((f) => f.type === "error" && f.clientId === "r2");
  assert.equal(err.error, "file_in_use");

  socket.close();
});

test("you cannot attach a file you did not upload", async () => {
  const owner = await signIn("owner_u");
  const thief = await signIn("thief_u");
  await thief.call("POST", "/api/conversations", { username: "owner_u" });
  const { body: convo } = await thief.call("POST", "/api/conversations", { username: "owner_u" });

  const { body: up } = await owner.upload(PNG_1X1, "mine.png", "image/png");

  const socket = connect(thief.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));

  // Attaching someone else's file would be a legitimate-looking way to read it.
  socket.send({
    type: "msg:send",
    conversationId: convo.conversation.id,
    fileId: up.file.fileId,
    clientId: "steal",
  });
  const err = await socket.wait((f) => f.type === "error" && f.clientId === "steal");
  assert.equal(err.error, "file_not_found");

  socket.close();
});

test("a range request returns exactly the bytes asked for", async () => {
  const una = await signIn("una");
  const vic = await signIn("vic");
  const { body } = await una.call("POST", "/api/conversations", { username: "vic" });

  const { body: up } = await una.upload(PNG_1X1, "seek.png", "image/png");
  const socket = connect(una.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));
  socket.send({ type: "msg:send", conversationId: body.conversation.id, fileId: up.file.fileId, clientId: "rg" });
  await socket.wait((f) => f.type === "msg:new" && f.clientId === "rg");

  // 206 is what lets video and voice notes scrub; without it a seek
  // re-downloads from byte zero.
  const partial = await vic.fetchFile(up.file.fileId, { Range: "bytes=0-9" });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-9/${PNG_1X1.length}`);
  assert.equal(Buffer.from(await partial.arrayBuffer()).length, 10, "an inclusive range is end - start + 1");

  const unsatisfiable = await vic.fetchFile(up.file.fileId, { Range: "bytes=99999-" });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${PNG_1X1.length}`);

  socket.close();
});

test("storage usage is recomputed from the files themselves", async () => {
  const wes = await signIn("wes");
  const before = await wes.call("GET", "/api/me/storage");
  assert.equal(before.body.used, 0);

  await wes.upload(PNG_1X1, "counted.png", "image/png");

  // Recomputed from GridFS rather than a counter on the user: a drifted counter
  // would eventually lock someone out of their own account.
  const after = await wes.call("GET", "/api/me/storage");
  assert.equal(after.body.used, PNG_1X1.length);
  assert.equal(after.body.quota, 50 * 1024 * 1024);
});

test("a voice note survives upload, send, and reply", async () => {
  const yuri = await signIn("yuri");
  await signIn("zara");
  const { body } = await yuri.call("POST", "/api/conversations", { username: "zara" });
  const convoId = body.conversation.id;

  // The full EBML header of a real (tiny, silent) WebM file, so the upload is
  // not bytes we merely labelled as audio.
  const webm = Buffer.from(
    "1a45dfa39f4286810142f7810142f2810142f3810142f7810142f881014280864442574542188ac0383fb81e18943041000000000000000002000138030e1000000000000303881a03881a01f001038a0063000000000000388f0080400000000000000ff00000000000000010000000000ff00fe04380b5a9a014280a04f434d012800",
    "hex",
  );

  const up = await yuri.upload(webm, "note.webm", "audio/webm;codecs=opus");
  assert.equal(up.status, 201);
  assert.equal(up.body.file.kind, "audio");

  const socket = connect(yuri.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));

  // durationMs travels from the recorder through the message, so the recipient
  // sees how long the note is.
  socket.send({
    type: "msg:send",
    conversationId: convoId,
    fileId: up.body.file.fileId,
    body: "",
    durationMs: 4200,
    clientId: "vn",
  });
  const echo = await socket.wait((f) => f.type === "msg:new" && f.clientId === "vn");
  assert.equal(echo.message.kind, "audio");
  assert.equal(echo.message.attachment.durationMs, 4200);
  // The codec parameter is stripped at upload time — stored MIME types are
  // bare (audio/webm), the recorder's negotiated codec is a client-side detail.
  assert.equal(echo.message.attachment.mime, "audio/webm");

  socket.close();
});

test("a recording longer than the cap is clamped, not trusted", async () => {
  const abe = await signIn("abe_rec");
  await signIn("bea_rec");
  const { body } = await abe.call("POST", "/api/conversations", { username: "bea_rec" });

  const { body: up } = await abe.upload(PNG_1X1, "clamp.png", "image/png");
  const socket = connect(abe.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));

  // A client claiming an hour-long note is either broken or lying; either way
  // the stored value is bounded by the same cap the recorder enforces.
  socket.send({
    type: "msg:send",
    conversationId: body.conversation.id,
    fileId: up.file.fileId,
    durationMs: 3_600_000,
    clientId: "clamp",
  });
  const echo = await socket.wait((f) => f.type === "msg:new" && f.clientId === "clamp");
  assert.equal(echo.message.attachment.durationMs, 60_000);

  socket.close();
});

/**
 * Direct database access, for the handful of states no route reaches yet.
 * Used sparingly — a test that sets up through the driver is testing the
 * filter, not the flow that produces it.
 */
async function withDb(fn) {
  const client = await new MongoClient(URI).connect();
  try {
    return await fn(client.db(DB));
  } finally {
    await client.close();
  }
}

/** Opens a socket, sends each line, and waits for its echo. Returns the rows. */
async function say(actor, conversationId, lines) {
  const socket = connect(actor.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));
  const sent = [];
  for (const [i, body] of lines.entries()) {
    const clientId = `${actor.username}-${i}`;
    socket.send({ type: "msg:send", conversationId, body, clientId });
    const echo = await socket.wait((f) => f.type === "msg:new" && f.clientId === clientId);
    sent.push(echo.message);
  }
  socket.close();
  return sent;
}

test("search finds a message and hands back the thread it lives in", async () => {
  const mira = await signIn("mira_s");
  await signIn("noor_s");
  const { body } = await mira.call("POST", "/api/conversations", { username: "noor_s" });
  const convoId = body.conversation.id;

  await say(mira, convoId, ["nothing to see", "bring the asparagus on tuesday", "ok"]);

  const { status, body: found } = await mira.call("GET", "/api/search?q=asparagus");
  assert.equal(status, 200);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].conversationId, convoId);
  assert.equal(found.results[0].peer.username, "noor_s");
  assert.equal(found.results[0].mine, true);
  assert.match(found.results[0].excerpt, /asparagus/);
});

test("search never reaches a conversation you are not in", async () => {
  const opal = await signIn("opal_s");
  await signIn("pete_s");
  const stranger = await signIn("quinn_s");
  const { body } = await opal.call("POST", "/api/conversations", { username: "pete_s" });

  await say(opal, body.conversation.id, ["the pomegranate arrives friday"]);

  // The scope is built from the session user's own conversations, so there is
  // no query string that widens it — not even a conversationId you know.
  const mine = await opal.call("GET", "/api/search?q=pomegranate");
  assert.equal(mine.body.results.length, 1);

  const theirs = await stranger.call("GET", "/api/search?q=pomegranate");
  assert.equal(theirs.body.results.length, 0);

  const targeted = await stranger.call(
    "GET",
    `/api/search?q=pomegranate&conversationId=${body.conversation.id}`,
  );
  assert.equal(targeted.body.results.length, 0, "naming the conversation must not grant access to it");
});

test("cleared history stays out of search, not just out of the thread", async () => {
  const rosa = await signIn("rosa_s");
  await signIn("said_s");
  const { body } = await rosa.call("POST", "/api/conversations", { username: "said_s" });
  const convoId = body.conversation.id;

  const before = await say(rosa, convoId, ["the rhubarb was terrible"]);
  assert.equal((await rosa.call("GET", "/api/search?q=rhubarb")).body.results.length, 1);

  // "Delete for me" records the newest message that existed at the time, and
  // that id is the filter — not the wall clock. If it only guarded the thread
  // query, cleared history would walk straight back out through the search box.
  await withDb((db) =>
    db.collection("conversations").updateOne(
      { _id: new ObjectId(convoId) },
      {
        $set: {
          "participantState.$[me].clearedAt": new Date(),
          "participantState.$[me].clearedUpTo": new ObjectId(before[0].id),
        },
      },
      { arrayFilters: [{ "me.user": new ObjectId(rosa.id) }] },
    ),
  );

  const after = await rosa.call("GET", "/api/search?q=rhubarb");
  assert.equal(after.body.results.length, 0, "cleared history must not be searchable");

  // Cleared for one side only. The other person's copy is untouched.
  const said = await signIn("said_s");
  const theirs = await said.call("GET", "/api/search?q=rhubarb");
  assert.equal(theirs.body.results.length, 1);
  assert.equal(theirs.body.results[0].message.id, before[0].id);
});

test("a search result opens a window around itself, with newer messages flagged", async () => {
  const tara = await signIn("tara_s");
  await signIn("umar_s");
  const { body } = await tara.call("POST", "/api/conversations", { username: "umar_s" });
  const convoId = body.conversation.id;

  // 8 sends stays inside the 12-token burst allowMessage() grants.
  const sent = await say(tara, convoId, ["a1", "a2", "a3", "a4", "the quince", "a6", "a7", "a8"]);
  const target = sent[4];

  // limit 4 → half 2 each side, so with 4 messages either side both flags are
  // exercised: history continues below the window, and — the point of the new
  // flag — the window is not the live end of the thread. A client that assumed
  // it was would append arrivals directly after months-old history.
  const { body: win } = await tara.call(
    "GET",
    `/api/conversations/${convoId}/messages?at=${target.id}&limit=4`,
  );

  const ids = win.messages.map((m) => m.id);
  assert.ok(ids.includes(target.id), "the window must contain the message it centres on");
  assert.deepEqual(ids, [...ids].sort(), "a window is still oldest-first");
  // The whole point of the flag: this window is not the live end of the thread,
  // and a client that assumed it was would append arrivals in the wrong place.
  assert.equal(win.hasNewer, true);
  assert.equal(win.hasMore, true);

  // A plain page is always the live end.
  const { body: tail } = await tara.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(tail.hasNewer, false);
});

test("a malformed id is refused, never a 500", async () => {
  const vic = await signIn("vic_s");
  await signIn("wren_s");
  const { body } = await vic.call("POST", "/api/conversations", { username: "wren_s" });
  const convoId = body.conversation.id;

  // Anything shaped like an id and handed to mongoose uncast throws a CastError
  // deep in the driver, which surfaces as 500 "server_error" — the server saying
  // *it* is broken when the client merely typed nonsense. Each of these paths
  // reaches a query, so each has to check the shape first.
  const cases = [
    ["a conversation id", `/api/conversations/zzz/messages`, 404],
    ["a thread cursor", `/api/conversations/${convoId}/messages?before=zzz`, 400],
    ["a window target", `/api/conversations/${convoId}/messages?at=zzz`, 400],
    ["a search cursor", `/api/search?q=hello&before=zzz`, 400],
    ["a search scope", `/api/search?q=hello&conversationId=zzz`, 400],
    ["a file id", `/api/files/zzz`, 404],
  ];

  for (const [what, url, expected] of cases) {
    const res = await vic.call("GET", url);
    assert.equal(res.status, expected, `${what} (${url}) → ${res.status}`);
    assert.notEqual(res.body.error, "server_error", `${what} must not read as a server fault`);
  }

  // A 24-hex id that simply does not exist is a different answer from a
  // malformed one, and must stay a plain not-found rather than an error.
  const ghost = await vic.call("GET", `/api/conversations/${"0".repeat(24)}/messages`);
  assert.equal(ghost.status, 404);

  // The socket takes ids too, and its frames are wholly attacker-shaped.
  const sock = connect(vic.cookie);
  await sock.open();
  sock.send({ type: "msg:send", conversationId: "zzz", body: "hi", clientId: "c1" });
  const bad = await sock.wait((f) => f.type === "error" && f.clientId === "c1");
  assert.equal(bad.error, "not_found");

  // A typo'd `upTo` must not fall through to "no bound" and mark the whole
  // thread read.
  sock.send({ type: "msg:read", conversationId: convoId, upTo: "zzz" });
  const cursor = await sock.wait((f) => f.type === "error" && f.error === "bad_cursor");
  assert.equal(cursor.error, "bad_cursor");
  sock.close();
});

test("deleting a message for everyone leaves a tombstone and takes its bytes", async () => {
  const uma = await signIn("uma_d");
  const vik = await signIn("vik_d");
  const { body } = await uma.call("POST", "/api/conversations", { username: "vik_d" });
  const convoId = body.conversation.id;

  const { body: up } = await uma.upload(PNG_1X1, "regret.png", "image/png");
  const { fileId } = up.file;

  const umaWs = connect(uma.cookie);
  const vikWs = connect(vik.cookie);
  await Promise.all([umaWs.open(), vikWs.open()]);
  await Promise.all([umaWs.wait(typeIs("hello")), vikWs.wait(typeIs("hello"))]);

  umaWs.send({ type: "msg:send", conversationId: convoId, fileId, body: "sent in haste", clientId: "d1" });
  const echo = await umaWs.wait((f) => f.type === "msg:new" && f.clientId === "d1");
  await vikWs.wait(typeIs("msg:new"));
  const messageId = echo.message.id;

  const gone = vikWs.wait(typeIs("msg:deleted"));
  const del = await uma.call("DELETE", `/api/conversations/${convoId}/messages/${messageId}`);
  assert.equal(del.status, 200);

  // The other side is told, unprompted.
  const frame = await gone;
  assert.equal(frame.messageId, messageId);

  // What survives is a tombstone: no body, no attachment, and the row still there
  // so the timeline does not reflow.
  const row = await withDb((db) => db.collection("messages").findOne({ _id: new ObjectId(messageId) }));
  assert.ok(row, "the row itself is kept");
  assert.equal(row.body, undefined, "the text is gone");
  assert.equal(row.attachment, undefined, "the attachment pointer is gone");
  assert.equal(row.deletedForEveryone, true);

  // And the bytes are actually gone, chunks included — not just unreferenced.
  assert.equal((await vik.fetchFile(fileId)).status, 404);
  const chunks = await withDb((db) =>
    db.collection("attachments.chunks").countDocuments({ files_id: new ObjectId(fileId) }),
  );
  assert.equal(chunks, 0, "no orphaned chunks");

  // The thread still serves the message, flagged, so both sides agree on history.
  const { body: page } = await vik.call("GET", `/api/conversations/${convoId}/messages`);
  const served = page.messages.find((m) => m.id === messageId);
  assert.equal(served.deleted, true);
  assert.equal(served.body, undefined);

  umaWs.close();
  vikWs.close();
});

test("only the sender can delete a message for everyone", async () => {
  const wes = await signIn("wes_d");
  const xena = await signIn("xena_d");
  const { body } = await wes.call("POST", "/api/conversations", { username: "xena_d" });
  const convoId = body.conversation.id;

  const [sent] = await say(wes, convoId, ["mine, not yours"]);

  // The recipient cannot delete it for everyone — and gets the same 404 as a
  // message that does not exist, so the route never confirms what it holds.
  const asPeer = await xena.call("DELETE", `/api/conversations/${convoId}/messages/${sent.id}`);
  assert.equal(asPeer.status, 404);

  const row = await withDb((db) => db.collection("messages").findOne({ _id: new ObjectId(sent.id) }));
  assert.equal(row.body, "mine, not yours", "still intact");
});

test("delete for me empties my copy and leaves theirs untouched", async () => {
  const yuri = await signIn("yuri_d");
  const zane = await signIn("zane_d");
  const { body } = await yuri.call("POST", "/api/conversations", { username: "zane_d" });
  const convoId = body.conversation.id;

  await say(yuri, convoId, ["one", "two", "three"]);

  const del = await yuri.call("DELETE", `/api/conversations/${convoId}?scope=me`);
  assert.equal(del.status, 200);
  assert.equal(del.body.scope, "me");

  // Gone for the person who asked: no messages, and off the sidebar.
  const mine = await yuri.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(mine.body.messages.length, 0);
  const list = await yuri.call("GET", "/api/conversations");
  assert.equal(
    list.body.conversations.find((c) => c.id === convoId),
    undefined,
    "hidden from my sidebar",
  );

  // Untouched for the other person, who was never told.
  const theirs = await zane.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(theirs.body.messages.length, 3);
  const theirList = await zane.call("GET", "/api/conversations");
  const row = theirList.body.conversations.find((c) => c.id === convoId);
  assert.ok(row, "still on their sidebar");
  assert.equal(row.closedByPeer, false, "and they get no notice");

  // Writing to me again brings the thread back — but only what came after.
  await say(zane, convoId, ["still here?"]);
  const revived = await yuri.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(revived.body.messages.length, 1);
  assert.equal(revived.body.messages[0].body, "still here?");
});

test("clearing and replying in the same second still revives the thread", async () => {
  const ines = await signIn("ines_d");
  const jude = await signIn("jude_d");
  const { body } = await ines.call("POST", "/api/conversations", { username: "jude_d" });
  const convoId = body.conversation.id;

  await say(ines, convoId, ["before the clear"]);

  // No pause anywhere in here. The bound used to be synthesised from the clear's
  // timestamp, and an ObjectId's clock is second-granular — so a reply landing in
  // the same second as the clear fell below the bound and was hidden forever.
  // The thread could never revive, which is not "delete for me" but "delete
  // permanently, silently, sometimes". The bound is now the last message's id.
  await ines.call("DELETE", `/api/conversations/${convoId}?scope=me`);
  const [reply] = await say(jude, convoId, ["and immediately after"]);

  const mine = await ines.call("GET", `/api/conversations/${convoId}/messages`);
  assert.deepEqual(
    mine.body.messages.map((m) => m.body),
    ["and immediately after"],
    "a reply in the same second as the clear must survive it",
  );

  // And back on my sidebar, since a new message unhides the thread.
  const list = await ines.call("GET", "/api/conversations");
  const row = list.body.conversations.find((c) => c.id === convoId);
  assert.ok(row, "the thread returns to my sidebar");
  assert.equal(row.unread, 1);

  // Searchable too — the bound has to mean the same thing on both read paths.
  const found = await ines.call("GET", "/api/search?q=immediately");
  assert.equal(found.body.results.length, 1);
  assert.equal(found.body.results[0].message.id, reply.id);
  assert.equal(
    (await ines.call("GET", "/api/search?q=before")).body.results.length,
    0,
    "and what I cleared stays cleared",
  );
});

test("delete for everyone empties both copies and says who did it", async () => {
  const abe = await signIn("abe_d");
  const bea = await signIn("bea_d");
  const { body } = await abe.call("POST", "/api/conversations", { username: "bea_d" });
  const convoId = body.conversation.id;

  const { body: up } = await abe.upload(PNG_1X1, "shared.png", "image/png");
  const socket = connect(abe.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));
  socket.send({ type: "msg:send", conversationId: convoId, fileId: up.file.fileId, clientId: "e1" });
  await socket.wait((f) => f.type === "msg:new" && f.clientId === "e1");
  socket.close();

  const beaWs = connect(bea.cookie);
  await beaWs.open();
  await beaWs.wait(typeIs("hello"));
  const notice = beaWs.wait(typeIs("convo:destroyed"));

  const del = await abe.call("DELETE", `/api/conversations/${convoId}?scope=everyone`);
  assert.equal(del.status, 200);

  // The notice names the person, which is what makes this defensible rather than
  // history quietly vanishing from someone else's account.
  const frame = await notice;
  assert.equal(frame.by.username, "abe_d");

  const left = await withDb((db) => db.collection("messages").countDocuments({ conversation: new ObjectId(convoId) }));
  assert.equal(left, 0, "both copies, not just the asker's");
  assert.equal((await bea.fetchFile(up.file.fileId)).status, 404, "and the bytes with them");

  // They keep the row so the notice has somewhere to live, then dismiss it.
  const list = await bea.call("GET", "/api/conversations");
  assert.equal(list.body.conversations.find((c) => c.id === convoId).closedByPeer, true);

  assert.equal((await bea.call("POST", `/api/conversations/${convoId}/dismiss`)).status, 200);
  const after = await bea.call("GET", "/api/conversations");
  assert.equal(after.body.conversations.find((c) => c.id === convoId), undefined);

  beaWs.close();
});

test("account deletion anonymizes by default and parks the handle forever", async () => {
  const cleo = await signIn("cleo_d");
  const dana = await signIn("dana_d");
  const { body } = await cleo.call("POST", "/api/conversations", { username: "dana_d" });
  const convoId = body.conversation.id;
  await say(cleo, convoId, ["remember this"]);

  // Typing the wrong handle changes nothing.
  const wrong = await cleo.call("DELETE", "/api/me", { confirmUsername: "not_me" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "confirm_username");
  assert.equal((await cleo.call("GET", "/api/me")).body.user.username, "cleo_d");

  const danaWs = connect(dana.cookie);
  await danaWs.open();
  await danaWs.wait(typeIs("hello"));
  const told = danaWs.wait(typeIs("peer:deleted"));

  const del = await cleo.call("DELETE", "/api/me", { confirmUsername: "cleo_d" });
  assert.equal(del.status, 200);
  assert.equal(del.body.mode, "anonymize");
  assert.equal((await told).purged, false);

  // The message stays — it is half of someone else's conversation — but the
  // author is now nobody.
  const theirs = await dana.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(theirs.body.messages.length, 1);
  assert.equal(theirs.body.messages[0].body, "remember this");
  const list = await dana.call("GET", "/api/conversations");
  assert.equal(list.body.conversations.find((c) => c.id === convoId).peer.displayName, "Deleted user");

  // The session is dead everywhere, not just in this cookie jar.
  assert.equal((await cleo.call("GET", "/api/me")).body.user, null);

  // And the handle can never be worn by anyone else.
  const impostor = await signIn("gil_d");
  const claim = await impostor.call("POST", "/api/me/username", { username: "cleo_d" });
  assert.equal(claim.status, 409);
  assert.equal(claim.body.error, "reserved");

  danaWs.close();
});

test("purging an account erases every message it sent", async () => {
  const eli = await signIn("eli_d");
  const fern = await signIn("fern_d");
  const { body } = await eli.call("POST", "/api/conversations", { username: "fern_d" });
  const convoId = body.conversation.id;

  const { body: up } = await eli.upload(PNG_1X1, "purged.png", "image/png");
  const socket = connect(eli.cookie);
  await socket.open();
  await socket.wait(typeIs("hello"));
  socket.send({ type: "msg:send", conversationId: convoId, fileId: up.file.fileId, body: "erase me", clientId: "p1" });
  await socket.wait((f) => f.type === "msg:new" && f.clientId === "p1");
  socket.close();
  await say(fern, convoId, ["but keep mine"]);

  const del = await eli.call("DELETE", "/api/me", { confirmUsername: "eli_d", mode: "purge" });
  assert.equal(del.status, 200);
  assert.equal(del.body.mode, "purge");

  // Their half is gone entirely — no tombstone, because the account it belonged
  // to no longer exists to have deleted anything.
  const left = await fern.call("GET", `/api/conversations/${convoId}/messages`);
  assert.equal(left.body.messages.length, 1);
  assert.equal(left.body.messages[0].body, "but keep mine");
  assert.equal((await fern.fetchFile(up.file.fileId)).status, 404);
  const chunks = await withDb((db) =>
    db.collection("attachments.chunks").countDocuments({ files_id: new ObjectId(up.file.fileId) }),
  );
  assert.equal(chunks, 0);

  // The sidebar preview cannot still be quoting a message that no longer exists.
  const list = await fern.call("GET", "/api/conversations");
  assert.equal(list.body.conversations.find((c) => c.id === convoId).lastMessage.preview, "but keep mine");
});

test("logging out ends the session", async () => {
  const user = await signIn("leaver");
  assert.equal((await user.call("GET", "/api/me")).body.user.username, "leaver");

  await user.call("POST", "/auth/logout");
  const after = await user.call("GET", "/api/me");
  assert.equal(after.body.user, null);
});
