import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + WebSocket to the Express backend on PORT (default 3002).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": { target: "http://localhost:3002", changeOrigin: true },
      "/ws":  { target: "ws://localhost:3002", ws: true },
    },
  },
});
