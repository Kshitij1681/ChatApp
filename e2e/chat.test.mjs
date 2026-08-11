/**
 * End-to-end: two real browser contexts against the built app.
 *
 * This covers the last mile the protocol suite cannot — React actually mounted,
 * a socket surviving a reload, and the deletion dialogs driven the way a person
 * drives them. It needs three local things:
 *
 *   npm run build      the client built into client/dist
 *   mongod on :27017   a real database (chatapp_e2e is dropped on each run)
 *   msedge.exe         installed Edge, so there is no Chromium download
 *
 *   node e2e/chat.test.mjs
 *
 * Interactions go through visible text, ARIA labels, and radio values rather
 * than CSS classes. Tailwind classes are styling and churn freely; a test that
 * asserts on them fails on a redesign that broke nothing a user would notice.
 *
 * Text matching is case-insensitive, and that is not laziness. `innerText`
 * reports text as *rendered*, and this design uppercases labels in CSS — the
 * app's "Connected" arrives here as "CONNECTED". Matching the source case would
 * mean encoding a `text-transform` rule into every assertion, so that changing
 * one line of CSS breaks tests about the socket.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PORT = 9442;
const APP = `http://127.0.0.1:${PORT}`;
const URI = "mongodb://127.0.0.1:27017/chatapp_e2e";
const SECRET = "e2e-secret";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const WAIT = 10_000;

// ── driving the page ──────────────────────────────────────────────────────────

/** Waits for text to appear on screen. */
const seen = (page, text) =>
  page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t),
    { timeout: WAIT },
    text.toLowerCase(),
  );

/** Waits for text to leave the screen — the assertion most of these flows need. */
const gone = (page, text) =>
  page.waitForFunction(
    (t) => !document.body.innerText.toLowerCase().includes(t),
    { timeout: WAIT },
    text.toLowerCase(),
  );

const has = (page, text) =>
  page.evaluate((t) => document.body.innerText.toLowerCase().includes(t), text.toLowerCase());

/**
 * Clicks the button whose trimmed text matches exactly.
 *
 * Exact, not substring: the conversation dialog's submit button reads "Clear my
 * copy" and so does one of its radio labels, and "Delete account" is a prefix of
 * nothing here only by luck. A substring match would pick whichever came first
 * in the DOM, which is not a choice a test should make silently.
 *
 * `textContent`, not `innerText`, so the CSS casing is irrelevant here.
 */
async function clickText(page, text, selector = "button") {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((el) => el.textContent.trim() === t),
    { timeout: WAIT },
    selector,
    text,
  );
  const clicked = await page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t);
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    text,
  );
  assert.ok(clicked, `no ${selector} with text "${text}"`);
}

/**
 * Clicks a sidebar row — a search result or a conversation — by the handle it
 * contains.
 *
 * These rows are unavoidably substring matches: a conversation row renders as
 * avatar + handle + timestamp + preview + unread count, which concatenates to
 * something like "Pava8:19 pmYou: hello1". There is no exact text to match.
 * First-in-DOM is the right pick because search results and conversations sit
 * above the footer identity button, which carries your *own* handle.
 */
async function clickRow(page, needle) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("aside button")].some((b) => b.textContent.includes(t)),
    { timeout: WAIT },
    needle,
  );
  const clicked = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("aside button")].find((b) => b.textContent.includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, needle);
  assert.ok(clicked, `no sidebar row containing "${needle}"`);
}

/** Types a message and sends it, then waits for it to land in the sender's own thread. */
async function say(page, text) {
  await page.waitForSelector('textarea[aria-label="Message"]', { timeout: WAIT });
  await page.type('textarea[aria-label="Message"]', text);
  await page.click('button[aria-label="Send"]');
  await seen(page, text);
}

/**
 * Picks a radio in the open dialog by its value.
 *
 * The value is the scope the server will act on — "me", "everyone",
 * "anonymize", "purge" — so this asserts against the protocol rather than
 * against prose that can be reworded.
 */
async function choose(page, value) {
  const picked = await page.evaluate((v) => {
    const radio = document.querySelector(`[role="dialog"] input[type="radio"][value="${v}"]`);
    if (!radio) return false;
    radio.click();
    return true;
  }, value);
  assert.ok(picked, `no choice with value "${value}"`);
}

/**
 * A signed-in browser context.
 *
 * The cookie is minted by POST /auth/test-login from inside the page, so it is
 * set by the browser itself on the app's own origin — the same path a real
 * sign-in takes, minus the OAuth round trip that cannot be automated.
 */
async function signIn(username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(APP, { waitUntil: "domcontentloaded" });
  const status = await page.evaluate(
    async (u, secret) => {
      const r = await fetch("/auth/test-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-secret": secret },
        body: JSON.stringify({ username: u, displayName: u }),
      });
      return r.status;
    },
    username,
    SECRET,
  );
  assert.equal(status, 200, `test-login failed for ${username}`);

  await page.goto(APP, { waitUntil: "networkidle0" });
  await seen(page, `@${username}`);
  await seen(page, "Connected"); // the socket, not just the REST bootstrap
  return { ctx, page, username, errors };
}

/** Opens a fresh thread from the sidebar search box. */
async function open(actor, handle) {
  const box = 'input[placeholder^="Search handles"]';
  await actor.page.click(box);
  await actor.page.type(box, handle);
  await seen(actor.page, "People");
  await clickRow(actor.page, `@${handle}`);
  await actor.page.waitForSelector('textarea[aria-label="Message"]', { timeout: WAIT });
}

// ── flows ─────────────────────────────────────────────────────────────────────

/** Phases 2–6: a message crosses, survives a reload, and is findable. */
async function messagingWorks() {
  const ava = await signIn("e2e_ava");
  const omar = await signIn("e2e_omar");

  await open(ava, "e2e_omar");
  await say(ava.page, "the channel is open");

  // Omar's sidebar learned about a conversation he never opened — that row
  // arrived over the socket, not from a poll.
  await seen(omar.page, "e2e_ava");
  await clickRow(omar.page, "e2e_ava");
  await seen(omar.page, "the channel is open");
  await say(omar.page, "reading you");
  await seen(ava.page, "reading you");

  // A reload has to rebuild the thread from the API and re-open the socket.
  await omar.page.reload({ waitUntil: "networkidle0" });
  await seen(omar.page, "Connected");
  await clickRow(omar.page, "e2e_ava");
  await seen(omar.page, "the channel is open");

  await say(ava.page, "still here after a reload");
  await seen(omar.page, "still here after a reload");

  // Search reaches message bodies, not just handles.
  await ava.page.click('input[placeholder^="Search handles"]');
  await ava.page.type('input[placeholder^="Search handles"]', "reading");
  await seen(ava.page, "Messages");
  await seen(ava.page, "reading you");
  await ava.page.click('button[aria-label="Clear search"]');

  await omar.ctx.close();
  await ava.ctx.close();
}

/** A message tombstone, on both sides, and only the sender can make one. */
async function messageTombstone() {
  const rose = await signIn("e2e_rose");
  const jude = await signIn("e2e_jude");

  await open(rose, "e2e_jude");
  await say(rose.page, "regrettable words");
  await clickRow(jude.page, "e2e_rose");
  await seen(jude.page, "regrettable words");

  // The recipient has no delete affordance on someone else's message.
  const theirHandles = await jude.page.$$('button[aria-label="Delete this message for everyone"]');
  assert.equal(theirHandles.length, 0, "only the sender may delete for everyone");

  await rose.page.click('button[aria-label="Delete this message for everyone"]');
  await seen(rose.page, "Delete this message?");
  await clickText(rose.page, "Delete for everyone");

  // The words go on both sides; the marker stays on both sides.
  await gone(rose.page, "regrettable words");
  await gone(jude.page, "regrettable words");
  await seen(rose.page, "deleted");
  await seen(jude.page, "deleted");

  await jude.ctx.close();
  await rose.ctx.close();
}

/** "Clear my copy" is one-sided, silent, and revivable. */
async function clearMyCopy() {
  const ines = await signIn("e2e_ines");
  const koto = await signIn("e2e_koto");

  await open(ines, "e2e_koto");
  await say(ines.page, "just between us");
  await clickRow(koto.page, "e2e_ines");
  await seen(koto.page, "just between us");

  await ines.page.click('button[aria-label="Conversation options"]');
  await clickText(ines.page, "Delete conversation…");
  await seen(ines.page, "Delete this conversation?");
  await choose(ines.page, "me");
  await clickText(ines.page, "Clear my copy", '[role="dialog"] button');

  // Gone from my side. Untouched on theirs, and they were not told.
  await gone(ines.page, "just between us");
  assert.equal(await has(koto.page, "just between us"), true, "their copy is untouched");
  assert.equal(await has(koto.page, "deleted this conversation"), false, "and they are not told");

  // Nothing was destroyed, so a reply brings the thread back.
  await say(koto.page, "are you still there");
  await seen(ines.page, "are you still there");

  // ...and what I cleared stays cleared — after a reload, which is the only way
  // to ask the *server* this question. Up to here the thread has been the
  // client's own memory: it emptied itself optimistically and appended the reply
  // from the socket, so a server that had forgotten the bound entirely would
  // still look correct on this screen. The refetch is the assertion.
  await ines.page.reload({ waitUntil: "networkidle0" });
  await seen(ines.page, "Connected");
  await clickRow(ines.page, "e2e_koto");
  await seen(ines.page, "are you still there");
  assert.equal(await has(ines.page, "just between us"), false, "the cleared history stays cleared");

  await koto.ctx.close();
  await ines.ctx.close();
}

/** "Delete for both of us" destroys both copies and leaves a notice. */
async function deleteForBoth() {
  const nils = await signIn("e2e_nils");
  const wren = await signIn("e2e_wren");

  await open(nils, "e2e_wren");
  await say(nils.page, "this was ours");
  await clickRow(wren.page, "e2e_nils");
  await seen(wren.page, "this was ours");

  await nils.page.click('button[aria-label="Conversation options"]');
  await clickText(nils.page, "Delete conversation…");
  await choose(nils.page, "everyone");
  await clickText(nils.page, "Delete for both", '[role="dialog"] button');

  await gone(nils.page, "this was ours");
  await gone(wren.page, "this was ours");
  // The notice is what separates this from silent destruction on their account.
  await seen(wren.page, "deleted this conversation for both of you");

  await wren.ctx.close();
  await nils.ctx.close();
}

/** Account deletion, anonymize by default, gated on typing your own handle. */
async function deleteAccount() {
  const izzy = await signIn("e2e_izzy");
  const lenn = await signIn("e2e_lenn");

  await open(izzy, "e2e_lenn");
  await say(izzy.page, "signing off for good");
  await clickRow(lenn.page, "e2e_izzy");
  await seen(lenn.page, "signing off for good");

  // The footer identity button carries your own handle and opens the menu.
  await clickRow(izzy.page, "@e2e_izzy");
  await clickText(izzy.page, "Settings");
  await clickText(izzy.page, "Delete my account…");
  await seen(izzy.page, "Delete your account");

  // The confirm button stays disabled until the handle matches.
  const disabledBefore = await izzy.page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] button')].some(
      (b) => b.textContent.trim() === "Delete account" && b.disabled,
    ),
  );
  assert.ok(disabledBefore, "deletion is gated on typing your own handle");

  await izzy.page.type('[role="dialog"] input[placeholder^="@"]', "e2e_izzy");
  await clickText(izzy.page, "Delete account", '[role="dialog"] button');

  // The server killed the session, so the app falls back to the door.
  await seen(izzy.page, "Two people,");

  // Anonymize keeps the message and drops the identity, live on the peer's
  // open thread rather than only after they reload.
  await seen(lenn.page, "Deleted user");
  assert.equal(await has(lenn.page, "signing off for good"), true, "their copy survives");
  assert.equal(await has(lenn.page, "e2e_izzy"), false, "the handle is gone from their view");

  await lenn.ctx.close();
  await izzy.ctx.close();
}

/**
 * The delivery tick moves when the recipient connects — unattended.
 *
 * The protocol suite proves the server sends the receipt. This proves the
 * sender's screen acts on it: Tomas writes while Priya has no socket at all, so
 * the bubble is "Sent"; Priya opens a tab and does not open the thread; and the
 * tick has to become "Delivered" without Tomas touching anything. It is the one
 * receipt state no other flow reaches, because everywhere else both people are
 * already connected and delivery happens at send time.
 */
async function deliveryOnConnect() {
  const tomas = await signIn("e2e_tomas");

  // Priya has to exist to be searchable, then has to be genuinely gone.
  const priya = await signIn("e2e_priya");
  await priya.ctx.close();

  await open(tomas, "e2e_priya");
  await say(tomas.page, "knock knock");

  // Nobody received it, so it must not claim otherwise.
  await tomas.page.waitForFunction(() => Boolean(document.querySelector('[aria-label="Sent"]')), {
    timeout: WAIT,
  });
  assert.equal(
    await tomas.page.$('[aria-label="Delivered"]'),
    null,
    "nothing can be delivered to someone with no connection",
  );

  // She opens a tab. Connecting is the whole act — she never opens the thread.
  const priyaAgain = await signIn("e2e_priya");

  // Tomas is not touched. The tick moves on its own or the sweep never reached
  // the screen.
  await tomas.page.waitForFunction(
    () => Boolean(document.querySelector('[aria-label="Delivered"]')),
    { timeout: WAIT },
  );

  await priyaAgain.ctx.close();
  await tomas.ctx.close();
}

// ── harness ───────────────────────────────────────────────────────────────────

const FLOWS = [
  messagingWorks,
  messageTombstone,
  clearMyCopy,
  deleteForBoth,
  deliveryOnConnect,
  deleteAccount,
];

let server;
let browser;

function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      MONGODB_URI: URI,
      SESSION_SECRET: "e2e-session-secret",
      CLIENT_ORIGIN: APP,
      ALLOWED_ORIGINS: APP,
      ALLOW_TEST_LOGIN: "1",
      TEST_LOGIN_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in 20s")), 20_000);
    proc.stdout.on("data", (b) => {
      if (String(b).includes("http + ws on")) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
}

if (!EDGE) {
  console.error("Edge not found. Install it, or point EDGE at a Chromium binary.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "client", "dist", "index.html"))) {
  console.error("client/dist is missing. Run `npm run build` first.");
  process.exit(1);
}

// A run must not inherit state. Handles are reserved permanently on account
// deletion, so e2e_izzy could never sign in twice against the same database.
const mongo = await new MongoClient(URI).connect().catch(() => null);
if (!mongo) {
  console.error(`Cannot reach mongod at ${URI}. Start it and try again.`);
  process.exit(1);
}
await mongo.db().dropDatabase();
await mongo.close();

server = await startServer();
browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check"],
});

let failed = 0;
for (const flow of FLOWS) {
  const started = Date.now();
  try {
    await flow();
    console.log(`ok - ${flow.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${flow.name}\n    ${err.message.split("\n")[0]}`);
  }
}

await browser.close();
server.kill();

console.log(`\n# flows ${FLOWS.length}\n# pass ${FLOWS.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
