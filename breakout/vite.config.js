import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  // strictPort so a busy 3004 fails loudly instead of silently moving to 3005 and
  // leaving you loading the wrong URL.
  server: { port: 3004, strictPort: true, proxy: { "/api": "http://localhost:3003" } },
});
