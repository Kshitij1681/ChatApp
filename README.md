# chat-app

One-to-one direct messaging. Text, images, files, voice notes and video notes,
with presence, typing indicators, delivery and read receipts, full-text search,
and deletion that actually deletes.

Two people, one thread each. There are no group channels — that is a scope
decision, not a missing feature.

---

## Requirements

- **Node 20+** (the suites use `node --test` and `fetch`, both built in) —
  declared as `engines` in all three manifests so a host doesn't pick older
- **MongoDB** — an Atlas cluster for real use, or a local `mongod` for tests
- A **Google** and/or **GitHub** OAuth app

## Setup

### 1. Register the OAuth apps

You need at least one. Each wants a callback URL, and it has to match exactly.

**The URL to register is the one you browse, not the one the server listens
on.** `server/auth/passport.js` uses a *relative* `callbackURL`, so passport
builds the absolute `redirect_uri` from the `Host` header of the request that
started the flow. Running `npm run dev` you browse Vite on `:5173`, which
proxies `/auth` through without rewriting `Host` — so Google is asked to
redirect to `:5173`, and a `:8000` registration fails with `redirect_uri_mismatch`.

**Google** — [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
→ Create OAuth client ID → Web application. Google accepts several redirect
URIs, so register both and each way of running works:

```
http://localhost:5173/auth/google/callback     ← npm run dev
http://localhost:8000/auth/google/callback     ← npm start
```

**GitHub** — [github.com/settings/developers](https://github.com/settings/developers)
→ New OAuth App. GitHub allows exactly **one** callback URL per app, so point it
at the way you develop and register a second app later if you need the other:

```
http://localhost:5173/auth/github/callback
```

In production this subtlety disappears: the server serves the client from its
own origin, so the `Host` is your real domain and
`https://your-domain/auth/<provider>/callback` is the only entry you need.

**You can run on one provider alone.** A strategy is only registered when its
credentials are present, `GET /api/me` reports the registered ones as
`providers`, and the sign-in screen renders exactly that list — so an
unconfigured provider never gets a button. Its route still answers `503` for
anyone who reaches it directly. Configure neither and the door says so, which is
the one case where the person reading the screen is the person who can fix it.

### 2. Configure

```bash
cp .env.example server/.env
```

Fill in `MONGODB_URI`, `SESSION_SECRET` (any long random string —
`openssl rand -hex 32`), and the client id/secret for each provider you
registered. Every variable is documented in `.env.example`.

`.env` is gitignored. Keep it that way.

If you change `PORT`, change `SERVER_PORT` in `client/vite.config.js` to match.
The dev server proxies `/api`, `/auth` and `/ws` to that number, and the two
defaults are kept equal on purpose — a mismatch leaves every request in the
browser hanging against a port with nothing behind it, which looks like a broken
app rather than a config typo.

### 3. Install and run

```bash
npm run setup    # installs root, server, and client
npm run dev      # server on :8000, Vite on :5173
```

Open **http://localhost:5173**. Sign in, claim a handle, and you are in.

For a production-shaped run, the server serves the built client from one origin:

```bash
npm run build
npm start        # everything on :8000
```

`npm start` does not set `NODE_ENV` — that is the deployment's job, and setting
it is what turns on the strict CSP, `secure` cookies, and HSTS. When you do set
it, clear the test-login flag **in `server/.env`**, not just in your shell:

```bash
NODE_ENV=production ALLOW_TEST_LOGIN= npm start
```

`dotenv` never overwrites a variable that is already in the environment, so
assigning it empty wins while _unsetting_ it does not — unset it and `.env`
fills it back in and the server exits 1. That crash is lock 4 doing its job, and
the fix is to empty the line in `server/.env` rather than to work around it.

---

## Deploying

**One process, one instance, and that is not a temporary shortcut.** Presence
lives in an in-memory `Map` in `server/ws/hub.js`, so two instances behind a
load balancer each know half the room. Turn autoscaling **off** rather than
leaving it at a default of 2. The fix when this matters is Redis pub/sub, not a
bigger instance count.

That rules out serverless-function hosts for the server. The WebSocket is
long-lived and the process holds state between requests, so it needs somewhere
that runs a persistent Node process — Render, Railway, Fly, or a plain VM.
**Render or Railway plus Atlas** is the least-effort pairing, and the rest of
this section assumes it.

Nothing needs a separate frontend host. Express serves `client/dist` with an SPA
fallback and the WebSocket shares the same HTTP server, so the whole app is one
origin — which is also what keeps the session cookie first-party on the socket
handshake.

### Service settings

| | |
| ------------ | ------------------------------- |
| Build        | `npm run setup && npm run build` |
| Start        | `npm start`                      |
| Health check | `/healthz`                       |
| Instances    | **1** — see above                |

The build has to include `npm run build`. Without `client/dist` the server boots
happily and every page answers "Client not built", because the SPA fallback is
the last route and it has nothing to send.

### Environment

Set these in the platform's dashboard, not in a committed file. `server/.env` is
gitignored and should stay that way; it is for your laptop.

| Variable | Production value |
| --------------------------- | ------------------------------------------------ |
| `NODE_ENV`                  | `production` — turns on strict CSP, `secure` cookies, HSTS |
| `MONGODB_URI`               | the Atlas SRV string                              |
| `SESSION_SECRET`            | a long random string, not the one from your laptop |
| `CLIENT_ORIGIN`             | `https://your-domain`                             |
| `ALLOWED_ORIGINS`           | `https://your-domain`                             |
| `PORT`                      | whatever the platform injects                     |
| `GOOGLE_CLIENT_ID`/`_SECRET`   | if you registered Google                       |
| `GITHUB_CLIENT_ID`/`_SECRET`   | if you registered GitHub                       |
| `ALLOW_TEST_LOGIN`          | **empty**                                         |

`NODE_ENV=production` is the deployment's job and nothing sets it for you.
Forget it and you get a server that looks fine and sends session cookies without
`secure`.

`ALLOWED_ORIGINS` needs the scheme and no trailing slash. It is not optional:
`assertSafeConfig()` exits 1 without it in production, for the reason in the
WebSocket note below.

In Atlas, allow the platform's egress IPs. Render and Railway don't publish
static ones, so in practice that is `0.0.0.0/0` — which is why the connection
string is the only thing standing between the internet and every message in the
database. Treat it accordingly.

### OAuth callbacks

`server/auth/passport.js` uses relative callback URLs, so passport derives the
absolute one from the incoming request. `app.set("trust proxy", 1)` makes
Express read `X-Forwarded-Proto` and `X-Forwarded-Host`, which is what makes
that derived URL `https` behind a TLS terminator. The `1` is a hop count — if
you later put Cloudflare in front of the platform's own proxy, it is wrong and
the redirect starts coming back `http`.

Register `https://your-domain/auth/google/callback` and the GitHub equivalent.
GitHub still allows one callback per app, so production wants its own OAuth app
rather than an edited dev one.

### After it's up

`/healthz` answering `{"ok":true}` only proves Express is listening. The things
that actually break in production break past that point, so check them:

- sign in with each provider you configured — this is where a wrong callback URL
  or a missing `trust proxy` shows up
- open two browsers and send a message, then watch presence and the receipt
  ticks. That is the socket working; HTTP alone would look identical until you
  looked for live updates
- hard-refresh a deep link like `/settings` to confirm the SPA fallback
- upload an image and reload — media lives in GridFS, not on disk, so an
  ephemeral filesystem is fine, but it counts against the same 512 MB the
  messages use on M0

---

## How it fits together

```
chat-app/
├── client/          React 19 · Vite 6 · Tailwind 4 · react-router 7
│   └── src/
│       ├── lib/socket.js      reconnecting socket, exponential backoff
│       ├── lib/recorder.js    MediaRecorder mime negotiation
│       ├── lib/limits.js      mirror of the server caps, to fail fast
│       ├── lib/api.js         fetch wrapper · lib/format.js  dates and sizes
│       ├── components/        Sidebar · Thread · Composer · MessageBubble ·
│       │                      Modal · Recorder · Avatar · EmptyThread
│       └── screens/           SignIn · ClaimUsername · Messenger · Settings
└── server/          Express 4 · ws 8 · mongoose 8
    ├── auth/        passport (google, github), session, routes
    ├── models/      User · Conversation · Message · ReservedUsername
    ├── routes/      me · users · conversations · search · uploads · files
    ├── ws/          connection (upgrade + auth) · handlers · hub (presence)
    └── lib/         deletion · gridfs · search · ids · ratelimit · sanitize · mime · guards
```

**One origin, one process.** The Express app and the WebSocket server share an
HTTP server, and in production Express also serves `client/dist`.

**The socket authenticates with the session cookie, not a token.** On
`upgrade`, the same `express-session` middleware instance runs over the raw
request; no session means `401` before the handshake completes. A token in the
query string would end up in access logs and `Referer` headers, and it would
mean two sources of truth about who someone is.

The upgrade also checks `Origin` against `ALLOWED_ORIGINS`. This is not
belt-and-braces: **browsers do not apply CORS to WebSocket handshakes**, so
without that check any page on the internet can open an authenticated socket
using your cookie. The server refuses to boot in production if the list is empty.

Every socket frame and every route derives the actor from the session. A `from`
field in a payload is ignored, always.

### The message protocol

Client → server: `msg:send` · `msg:read` · `typing` · `ping`
Server → client: `hello` · `msg:new` · `msg:status` · `msg:deleted` ·
`convo:cleared` · `convo:destroyed` · `peer:deleted` · `presence` · `typing` ·
`error` · `pong`

Receipts are monotonic — a late `delivered` packet can never overwrite a `read`
that already landed.

**Delivery is stamped by the connection, not only by the send.** A message sent
to someone whose laptop is shut stays `deliveredAt: null`, because nothing
received it. When their first socket opens, the server sweeps each of their
threads for unstamped messages, sets the mark, and sends one `msg:status` per
thread to whoever was waiting. Without that sweep the sender sits on one tick
until the recipient actually opens the thread and reads it, which reads as
"never arrived" when the truth is "arrived while they were away".

It fires once. The sweep runs only on the _first_ socket for a user, and the
update matches `deliveredAt: null`, so a second tab or a reconnect modifies
nothing and stays silent — otherwise a flaky connection would re-notify the
sender on every reconnect and flicker their ticks.

Media never travels on the socket. Bytes go to `POST /api/uploads` over HTTP and
come back as a `fileId` the message references; base64-over-WebSocket would
inflate every payload by a third and block the event loop for everyone else.

`GET /api/files/:id` is authenticated, and there are exactly two ways to qualify
for a file: you are a participant in the conversation whose message carries it,
or you uploaded it and have not attached it to a message yet. The second exists
so upload-then-send works without opening a window where a guessed id is public.
A tombstone's file is refused outright. Anything else is a `404` — the same
answer a missing id gets, so the route never becomes an existence oracle. It
supports `Range` so voice and video notes scrub properly.

---

## Read this before you trust it with anything

### Messages are not encrypted at rest

They are stored as plain text in MongoDB. TLS protects them in transit, and
that's all. **Anyone with database access can read every message and open every
file** — you, your hosting provider's staff, and anyone who obtains the
connection string.

That is the ordinary trade for server-side search, sidebar previews, and signing
in on a new device without ceremony. It is the same trade most mainstream chat
products make. But it is a trade, and the people using this deserve to know
which side of it they're on: this is not Signal. Don't let anyone assume
otherwise, and don't put anything in here you would not put in an email.

The app says so too, in Settings, rather than only here where users never look.

### "Delete for everyone" is not "unsend from reality"

The three deletions do what they say against the live database. What no
application can promise:

- **The oplog.** A replica set keeps a rolling log of every write, deletions
  included. A deleted message body survives there for the replication window.
- **Backups.** If snapshots are enabled, deleted content lives in them until
  those snapshots age out under whatever retention you configured.
- **The other person's browser.** Attachments are served `Cache-Control:
private`, which permits their browser to keep the bytes it already downloaded.
  Their copy of an image can outlive your delete.
- **Screenshots, forwards, and memory.** Obviously, but worth saying once.

What deletion _does_ guarantee is that the app will never serve that content
again, to anyone, and that the bytes leave GridFS.

### Other things to know

- **Accounts are keyed on `provider + providerId`.** Signing in with Google and
  then GitHub on the same email address creates **two separate accounts**.
  Account linking is deliberately out of scope for v1.
- **Presence is in-memory, so this runs as a single process.** Two instances
  behind a load balancer would each know about half the online users and get
  presence wrong for the other half. Moving the hub to Redis pub/sub is the fix
  when it matters; until then, run one — see [Deploying](#deploying).
- **Atlas M0 is 512 MB for everything** — messages, indexes, sessions, and file
  bytes together. With video notes in GridFS that is genuinely tight, which is
  what the caps below are protecting. Real capacity at these limits is roughly
  **six to eight active users**. Past that, move media to S3 or Cloudinary and
  keep only the metadata in Mongo.

---

## Deletion, precisely

Three separate operations. They live together in `server/lib/deletion.js`
because getting one subtly wrong is how deleted content comes back, and the
rules should be read side by side.

### A message, for everyone

Any of your own messages, with **no time limit** — a deliberate choice, not an
oversight. The body and attachment are unset and the GridFS bytes are deleted;
a ~120-byte tombstone stays behind forever.

Keeping the row is the point. Both sides continue to agree that something was
there and who removed it, and the timeline doesn't reflow under the other
person while they're reading it. Only the sender can do this, and that rule is
part of the query rather than an `if` after the fetch — a message someone else
sent is simply _not found_, so the route can never confirm that a message id
exists in a thread you aren't in.

### A conversation, two scopes

**Clear my copy.** Silent, and reversible in the only sense that matters: the
other side is unaffected and is not told, because "clear my copy" is not an
event in their history. Nothing is destroyed, so a later message brings the
thread back.

The bound is stored as `clearedUpTo` — the `_id` of the newest message that
existed at the moment you cleared. Not a timestamp, and the reason is worth
knowing if you touch this code: an ObjectId's clock is second-granular, so a
bound derived from a `Date` has to round, and **both roundings lose a message.**
Round down and something sent later in the same second stays visible — cleared
history leaking straight back. Round up and a reply arriving in that same second
falls below the bound and is hidden _forever_, so the thread can never revive.
There is no third rounding. The id expresses the split exactly.
`server/lib/ids.js` carries the long version, and one test pins it with no
`sleep` anywhere so the same-second path is actually exercised.

That bound is applied on **every** read path — thread, search, unread count, and
sidebar preview. Miss it on any one of them and cleared history comes back
through that door.

**Delete for both of us.** Every message and every attachment in the
conversation is destroyed for both people, and the other person is told:
their sidebar keeps a row saying you deleted it, until they dismiss it or one of
you writes again.

That notice is what makes the operation defensible rather than silent data
destruction on someone else's account. Without it their history would vanish
with no account of where it went, and they would reasonably conclude the app had
lost it.

### An account

Sessions on every device, GridFS files, presence, and the profile all go. The
handle is parked in `ReservedUsername` **permanently** — a stranger who could
later claim `@you` would inherit every place your name still appears in someone
else's history, which is the one impersonation this app cannot detect.

For the messages you sent to other people, you choose:

- **Leave my messages, shown as from "Deleted user"** — the default
- **Erase every message I ever sent**

Anonymize is the default because a conversation is jointly authored. Hard
deleting your half tears holes in someone else's record of their own life, and
the erasure right you are exercising covers your personal data, not the
counterparty's copy of a conversation you both had. Purge is offered because
some people mean exactly that — but it has to be chosen, and the whole flow is
gated behind typing your own handle.

Signing in again after deletion creates a _new_ account. The old one is not
resurrected: the provider link is severed, not just unset.

---

## Limits

|                     |                                           |
| ------------------- | ----------------------------------------- |
| Image               | 5 MB · no SVG, ever                       |
| Voice note          | 5 MB · 60 s                               |
| Video note          | 25 MB                                     |
| Any other file      | 25 MB                                     |
| Per-user storage    | 50 MB                                     |
| Cluster kill switch | 400 MB → `507` and a banner               |
| Message text        | 4 000 characters · truncated, not refused |
| Socket frame        | 8 KB accepted · 64 KB hard close          |

SVG is absent from the image allowlist and must stay absent: it is a document
that can carry `<script>`, not a picture, and served same-origin it would run
with full access to the session. There is no sanitizer here worth trusting.

Uploads are checked against an **allowlist of declared MIME types** — a
blocklist would be a promise to have thought of every dangerous type in advance,
which nobody can keep. Since the declared type is the client's word, that check
alone isn't the whole defense; a mislabeled SVG could get past it. What stops it
mattering is on the way back out: `GET /api/files/:id` serves the _allowlisted_
type rather than anything the uploader said, sends
`X-Content-Type-Options: nosniff` so the browser can't second-guess it, and
forces `Content-Disposition: attachment` on everything that isn't image, video,
or audio. An SVG smuggled in as `image/png` comes back as `image/png` and
renders as a broken image, not as script.

Storage quota is recomputed from GridFS on every upload rather than read from a
counter, so deletions genuinely give space back — a drifted counter would
eventually lock someone out of their own account.

The two socket-frame numbers are two different jobs. `ws` is configured with
`maxPayload: 64 KB`, which closes an oversized frame at the protocol level
without ever buffering it — that one exists so a client cannot make the server
hold 100 MB in memory before anyone gets to inspect it. The 8 KB check in
`ws/handlers.js` is the application's, and it answers with a readable error. A
frame between the two is refused politely; a frame above 64 KB is refused before
politeness is affordable.

Rate limits are token buckets keyed by **user id, not socket**, so opening a
second tab doesn't hand out a second allowance: 12 messages in reserve refilling
1/s, 20 searches refilling 2/s, 5 uploads refilling one every 10 s.

Usage is visible in Settings. Without a usage bar, a failed upload is baffling.

---

## Tests

```bash
npm test          # protocol suite — needs a mongod on 127.0.0.1:27017
npm run test:e2e  # two real browser contexts against the built app
```

Plain `node:assert/strict` and `node --test`, no jest or vitest. The protocol
suite spawns the real server against a real database and drops it first, because
most of what's under test is the database's behaviour rather than ours — unique
indexes, `E11000` races, `$text` search, `arrayFilters`.

46 tests. The ones worth knowing about:

- a session-less upgrade is refused; so is a disallowed `Origin`
- the sender is the session, never the payload
- a non-participant can read neither the thread nor its files
- an offline recipient is marked delivered when they connect, and a second
  connection with an empty backlog says nothing
- a tombstone leaves no body, and its file 404s with zero chunks left behind
- cleared history stays out of **search** as well as the thread
- clearing and replying in the same second still revives the thread
- cursor pagination returns no duplicates when a message lands mid-scroll
- a reserved handle can't be claimed; the 30-day cooldown holds
- **`/auth/test-login` returns 404 when its flag is off** — with the correct
  secret supplied, so a pass means the route is _absent_, not merely guarded
- **the server exits 1 rather than booting with that flag in production**
- a half-configured server offers only the provider it has credentials for —
  in its own spawned process, since strategies register at boot from env

### The browser suite

Six flows in two browser contexts driven by puppeteer-core: a message crossing
and surviving a reload, a tombstone, "clear my copy", "delete for both", the
delivery tick moving when the recipient connects, and account deletion. It needs
Edge installed (no Chromium download), a local `mongod`, and `client/dist` —
`npm run test:e2e` builds that for you.

Interactions go through visible text, ARIA labels, and radio `value`s, never CSS
classes: classes are styling and churn freely, and a test that asserts on them
fails on a redesign that broke nothing a user would notice. Text matching is
case-insensitive on purpose — `innerText` reports text as _rendered_, and this
design uppercases labels in CSS, so matching source case would encode a
`text-transform` rule into assertions about the socket.

One deliberate reload sits in the middle of the "clear my copy" flow. It looks
redundant and is not. Up to that point the thread on screen is the client's own
memory — it emptied itself optimistically and appended the reply from the
socket — so a server that had dropped the cleared bound entirely still looks
correct. Deleting the `_id` filter from `clearedFilter()` passes every other
assertion in that flow; only the refetch catches it. A test that cannot fail
when you break the thing it names is decoration.

The delivery flow is built the same way and was checked the same way: drop
`flushDelivery` from the connect path and it is the only one of the six that
goes red. It is also the only place the "Delivered" tick is reachable at all,
since everywhere else both people are already connected and delivery is stamped
at send time.

### About that test-login route

Automated suites can't drive real OAuth, so `POST /auth/test-login` exists. It
is the single riskiest thing in this codebase: a quiet auth backdoor reachable in
production is total compromise. It has four locks.

1. Mounted only when `ALLOW_TEST_LOGIN=1`
2. That flag is forced false whenever `NODE_ENV=production`
3. It requires a shared secret in `x-test-secret`
4. `assertSafeConfig()` **exits the process** at boot if the flag is set with
   `NODE_ENV=production`

Lock 4 crashes rather than warns on purpose. A warning in a log nobody reads is
exactly how this ships.

### Manual checks worth doing

Two browsers, two accounts, and confirm the message crosses and survives a
server restart. Then: a 5 MB jpg renders inline on both sides · a 30 MB file
gives a readable `413` · a stranger's `fileId` gives `404`, not `403` — see the
existence-oracle note below · `curl -H 'Range: bytes=0-99'` returns `206` with
exactly 100 bytes.

---

## If you extend this

- Message search uses Mongo's `$text` index, which matches **whole stemmed
  words** — "meet" finds "meeting", "eeti" finds nothing. Substring search is
  what Atlas Search is for; `server/lib/search.js` is one function so swapping
  it is a one-file change.
- Pagination is cursor-based on `_id` everywhere. Never reach for
  `skip`/`limit`: it reads and discards _n_ documents, and it is outright wrong
  under concurrent writes — a message arriving mid-scroll shifts every later
  page and the reader sees duplicates.
- Search excerpts are plain text and are never marked up. Handing the client
  HTML built from message bodies would hand every sender an XSS primitive; the
  client highlights by splitting on an escaped term.
- Ids from outside pass through `asObjectId` before they reach a query. An
  uncastable string throws a `CastError` deep in the driver, and the error
  handler can only turn that into a `500` — so a typo'd cursor would read as
  "the server is broken" instead of "that isn't an id".
- A bad **resource** id answers `404`, the same as a real id you have no access
  to, so routes never become existence oracles. A bad **cursor** answers
  `400 bad_cursor`, because that one is a bug on the client's side and it should
  be told which parameter was wrong.
