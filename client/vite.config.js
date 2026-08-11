import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERVER_PORT = process.env.SERVER_PORT ?? 8000;
const target = `http://localhost:${SERVER_PORT}`;

// Proxying /api, /auth and /ws means the client always talks to its own origin,
// so the same build works behind the dev server and behind Node in production.
// It also keeps the session cookie first-party, which is what makes the cookie
// ride the WebSocket handshake without any cross-site cookie rules getting involved.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      "/api": { target },
      "/auth": { target },
      "/healthz": { target },
    },
  },
});
