import { defineConfig } from "vitest/config";

// PR 11.6.D fix3 — vitest config for client-side boundary tests.
//
// We test pure-logic damage-bus code under Node, not under jsdom — the
// damageBus only reads `state.hp` + `state.respawningUntilMs` on a mock
// target, so no DOM / WebGL surface is required. The other
// dependencies (protocol/damage, game/health, engine/characterConfig)
// either are pure TS or only import `Vector3` from `@babylonjs/core`
// which is tree-shakable and works fine in Node.
//
// `include` only pulls in the .test.ts files we author; vitest will
// not scan `src/engine/scene.ts` (which gates itself on
// `import.meta.env.DEV` and pulls in @babylonjs) — keeping the test
// pass fast + lightweight.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      // PR 11.7.E / §3.5 — protocol/ dir at repo root holds wire-
      // format codec tests (mirroring the server's protocol_wire.rs
      // round-trips). The path is RELATIVE TO REPO ROOT because
      // vitest resolves the include globs from the project root
      // (which is client/), and we need to escape one level.
      "../protocol/**/*.test.ts",
    ],
    // DamageBus tracks module-level state (pendingApplies,
    // recentlySettled). `isolate: false` + `forks: false` keeps
    // the module shared across the file's tests, which is what
    // we want — the tests assert sequential state changes.
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
