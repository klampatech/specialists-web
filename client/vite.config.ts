import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PR 2026-09-06 / reverted — re-enable minify now that the actual
// root cause of the asymmetric render bug has been identified
// (the liveHook in wireServerTransport.ts was the unfixed one —
// scene.ts was a red herring). The minifier rename heuristic is
// a real footgun but the liveHook now writes to a window-scope
// property so elision would be observable. Keep minify on.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
  },
  server: {
    port: 5173,
    host: true,
  },
});
