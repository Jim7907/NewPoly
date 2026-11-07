import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'build', chunkSizeWarningLimit: 1500 },
  // `node alerts/server.js` for alerts in dev
  server: { port: 3000, proxy: { '/alerts-api': 'http://localhost:8080' } },
});
