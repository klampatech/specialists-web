// Phase 0 PR 1 deliverable: a React shell with a status banner.
// PR 2 will replace this banner with a Babylon.js canvas.
// The whole point of this PR is to prove the build pipeline (Vite + React + TS) boots.

export function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        background: "#0a0a0c",
        color: "#e6e6e6",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <h1 style={{ fontSize: "2rem", margin: 0 }}>Specialists Web</h1>
      <p style={{ margin: 0, opacity: 0.7 }}>Phase 0 — tooling baseline</p>
      <p style={{ margin: 0, opacity: 0.5, fontSize: "0.85rem" }}>
        Babylon.js scene + Havok character controller lands in PR 2.
      </p>
    </div>
  );
}
