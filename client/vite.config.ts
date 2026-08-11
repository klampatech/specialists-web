import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 0 client config. Vite + React + Babylon + Havok.
//
// Why `optimizeDeps.exclude: ["@babylonjs/havok"]`:
//   Havok's ESM uses `import.meta.url` to locate the wasm binary at runtime.
//   Vite's dep-pre-bundling rewrites that URL to a hashed path the wasm
//   fetch can't follow, causing a 404 / HTML fallback / "expected magic word
//   00 61 73 6d, found 3c 21 64 6f" error. Excluding the package from the
//   pre-bundle keeps the URL intact. See:
//     https://forum.babylonjs.com/t/unable-to-load-havok-plugin-error-while-loading-wasm-file-from-browser/40289
//     https://github.com/vitejs/vite/issues/7287
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
  },
  server: {
    port: 5173,
    host: true, // listen on 0.0.0.0 so a second tab on another host can join
  },
});
