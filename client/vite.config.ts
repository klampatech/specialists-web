import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 0 client config. Bare-bones — Babylon and Havok get wired in PR 2.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // listen on 0.0.0.0 so a second tab on another host can join
  },
});
