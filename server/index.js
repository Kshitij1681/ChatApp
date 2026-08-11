import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { assertSafeConfig, IS_PROD, PORT } from "./config.js";
import { connect, disconnect } from "./db/connection.js";
import { getSessionMiddleware } from "./auth/session.js";
import { configurePassport } from "./auth/passport.js";
import authRoutes from "./auth/routes.js";
import meRoutes from "./routes/me.js";
import userRoutes from "./routes/users.js";
import conversationRoutes from "./routes/conversations.js";
import searchRoutes from "./routes/search.js";
import uploadRoutes from "./routes/uploads.js";
import fileRoutes from "./routes/files.js";
import { attachWebSocket } from "./ws/connection.js";

// Before anything else: refuse to boot in an unsafe configuration.
assertSafeConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../client/dist");

const app = express();
app.set("trust proxy", 1); // behind a TLS terminator, `secure` cookies need this

app.use(
  helmet({
    contentSecurityPolicy: IS_PROD
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // Avatars come from Google/GitHub CDNs; media is our own blobs.
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            mediaSrc: ["'self'", "blob:"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "ws:", "wss:"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : false, // Vite's dev server needs inline/eval; CSP is enforced on the built app
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

app.use(express.json({ limit: "64kb" }));
app.use(getSessionMiddleware());

const passport = configurePassport();
app.use(passport.initialize());
app.use(passport.session());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/api", meRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/search", searchRoutes);
app.use("/api", uploadRoutes);
app.use("/api", fileRoutes);

app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

// The built client, plus an SPA fallback so a deep link survives a refresh.
app.use(express.static(clientDist, { index: false }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(404).send("Client not built. Run `npm run build`.");
  });
});

app.use((err, _req, res, _next) => {
  console.error("[chat] unhandled:", err);
  // Never leak a stack trace or a driver message to the client.
  res.status(err.status ?? 500).json({ error: "server_error" });
});

const server = createServer(app);
attachWebSocket(server);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[chat] ${signal} — closing`);
  server.close();
  await disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await connect();
  server.listen(PORT, () => {
    console.log(`[chat] http + ws on http://localhost:${PORT}`);
  });
} catch (err) {
  console.error("[chat] could not reach MongoDB:", err.message);
  process.exit(1);
}
