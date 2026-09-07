import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PR 2026-09-06 / debug-build — explicitly disable minify so the
// Vite/Terser optimizer stops renaming methods that share a prefix
// with another method (e.g. setVisualPositionAndCommit →
// setVisualPosition). The minify step is what was dropping the
// computeWorldMatrix(true) call in scene.ts. We will re-enable
// minify once the asymmetric render bug is fully diagnosed and
// fixed (the inline + sentinel pattern is fragile against the
// current Terser version's heuristics). For now: no-minify + full
// source maps so we can verify the actual code that gets shipped.
export default defineConfig({
  plugins: [react()],
  build: {
    minify: false,
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
  },
  server: {
    port: 5173,
    host: true,
  },
});
