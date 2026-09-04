// Phase 0 / PR 3+4+7 — React shell with Babylon canvas + HUD + WebRTC overlay.
//
// The canvas is mounted via a ref so the Babylon Engine can attach to it
// directly. The scene is built asynchronously (Havok wasm + WebGPU adapter
// are loaded), so we render a thin "Scene loading…" placeholder until the
// scene is ready. The `dispose()` handle lets us clean up on unmount so
// React StrictMode's double-mount doesn't leak a render loop.
//
// PR 4: the WebRTC `WebRTCPeer` is owned here (not inside PeerOverlay) so
// that App can hand it to `createScene` via a `GgnetTransport` wrapper. The
// GameSession ticks every frame regardless of connection state — the remote
// rig stays at its spawn with zero input until the peer actually sends
// packets. BulletHud shows the live frame number + connection state.
//
// PR 7: HUD grows a `hits:` counter (combat events emitted by the session)
// and a top-center "BULLET TIME" chip that lights red when the local tab
// holds T. KeybindHud adds the combat bindings. All polled at ~10Hz from
// the existing HUD interval — no per-frame React re-renders.

import { useCallback, useEffect, useRef, useState } from "react";
import { createScene, type SceneHandle } from "../engine/scene";
import { PLAYER_MAX_AMMO } from "../engine/characterConfig";
import { PeerOverlay } from "./PeerOverlay";
import { BulletHud } from "./BulletHud";
import { Crosshair } from "./Crosshair"; // PR #110 — center-screen weapon-aware crosshair.
import { DebugHud } from "./DebugHud";
import { PauseMenu } from "./PauseMenu";
import { Lobby } from "./Lobby";
// PR 11.7.D2 / §3.10 — WebRTCPeer + GgnetTransport imports REMOVED.
 // The P2P lockstep substrate is gone; see the header comment.

/** Snapshot the HUD reads each frame. We sample a handful of fields rather
 *  than the whole transport so React doesn't re-render on every input. */
interface HudState {
  /** "offline" / "waiting-ice" / "connected" / "disconnected" — displays as
   *  a single readable string in the overlay. */
  connectionStatus: "offline" | "waiting-ice" | "connected" | "disconnected";
  /** Latest lockstep frame the runtime has advanced. 0 before the first tick. */
  frame: number;
  /** Frames the runtime had to fill by repeating the last-known remote input. */
  repeatedFrames: number;
  /** True once the runtime has received at least one packet from the peer. */
  hasRemote: boolean;
  /** PR 7: total combat events emitted by the local session so far. */
  hits: number;
  /** PR 7: true while the local tab holds the T key (bullet time). */
  bulletTime: boolean;
  /** PR 10: live HP for the LOCAL controller (drives the HUD chip). */
  localHp: number;
  /** PR 10: live HP for the REMOTE controller. */
  remoteHp: number;
  /** PR 10: timestamp (ms) at which the LOCAL controller's respawn fires.
   *  0 when not respawning. */
  localRespawningMs: number;
  /** PR 10: same for the REMOTE controller. */
  remoteRespawningMs: number;
  /** PR 11.2: pointer-lock state from the chase camera. Drives the
   *  pause-menu visibility (visible when `!isPointerLocked && everLocked`,
   *  which mirrors `chase.isMenuOrbit()`). */
  isPointerLocked: boolean;
  /** PR 11.2: true once the user has engaged pointer-lock at least once.
   *  Used as the gate that prevents the menu from flashing on a fresh
   *  page that hasn't been interacted with yet. */
  everLocked: boolean;
  /** PR 11.2: current locked viewMode (0 first-person, 1 over-shoulder).
   *  Drives the "return to <view>" subtitle on the Resume button. */
  viewMode: number;
  /** PR 11.7.E / §3.5 — server-authoritative local ammo count.
   *  Sourced from `__latestSnap().players[localPlayerId].ammo`
   *  (NOT a local controller field — the snapshot is the single
   *  source of truth, mirroring the HP pattern). Drives the
   *  BulletHud ammo display ("▮▮▯▯▯ /6"). */
  localAmmo: number;
  /** PR 11.7.E / §3.5 — reload-progress timestamp
   *  (`performance.now()`-relative) or `null` when idle. Drives
   *  the BulletHud reload-progress bar. Cleared by the `__latestSnap`
   *  listener in scene.ts when the snapshot reports
   *  `localAmmo === PLAYER_MAX_AMMO`. */
  reloadingUntilMs: number | null;
  /** PR #108 — current weapon id (0=DualPistol, 1=Shotgun, 2=Sniper).
   *  Sourced from `gameSession.getLocalWeaponState()` (the
   *  optimistic local mirror; updated on every 20Hz snapshot via
   *  `_setLocalWeaponStateFromSnapshot`). */
  weaponId: number;
  /** PR #108 — current fire-mode index (0=Semi, 1=Burst3 on DualPistol).
   *  Drives the BulletHud chip's fire-mode label ("SEMI" / "BURST"). */
  fireModeIndex: number;
  /** PR #110 — local fire-held flag. Drives `<Crosshair>`'s recoil-
   *  spread cue (1.6× radius while LMB is held). Sourced from
   *  `gameSession.getFireHeld()` which returns the most recent
   *  tick's `input.fireHeld`. */
  fireHeld: boolean;
  /** PR #115 (post-#114) — snapshot-derived local `isFiring` (0 or 1
   *  wire-bool). Drives the BulletHud Burst-active badge ("●
   *  FIRING") when the local tab is in Burst3 mode AND firing.
   *  Note: `fireHeld` (input) ≠ `isFiring` (snapshot-derived);
   *  the snapshot's `isFiring` reflects the server's authoritative
   *  view of which player is firing — it includes the per-weapon
   *  fire-rate gate (Auto/Burst3 fireHeld=true may not yield
   *  `isFiring=1` on every tick). The HUD badge uses `isFiring`
   *  because that's what the wire carries. */
  isFiring: number;
}

export function App() {
  // PR 11.9 — matchmaker lobby. The lobby shows when:
  //   - We're in a production build (real user landed on the
  //     entry URL with no invite link), OR
  //   - The URL explicitly opts in via `?lobby=1` (manual QA +
  //     the lobby smoke).
  //
  // Dev builds default to the scene because developer machines +
  // CI smokes load the entry URL directly to test scene mount,
  // networking, and gameplay. Showing a lobby modal here would
  // block every existing client smoke. The production-only gate
  // keeps the lobby a real-user surface while preserving the
  // dev workflow.
  const [hasServerParam] = useState(() => {
    if (typeof window === "undefined") return false;
    const u = new URL(window.location.href);
    return !!u.searchParams.get("server");
  });
  const [forceLobby] = useState(() => {
    if (typeof window === "undefined") return false;
    const u = new URL(window.location.href);
    return u.searchParams.get("lobby") === "1";
  });
  if (forceLobby || (!hasServerParam && !import.meta.env.DEV)) {
    return <Lobby />;
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  // PR 11.7.D2 / §3.10 — peerRef REMOVED. No WebRTC peer to own;
  // the snapshot stream is the multiplayer connection now.
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [engineLabel, setEngineLabel] = useState<"webgpu" | "webgl2" | null>(null);
  // PR 11.7.D3 — Debug HUD visibility toggle (key: backtick `).
  // Auto-shows in prod when `?debug=1` is in the URL or
  // `localStorage.__debugHudOpen === "1"`. Toggle state syncs to
  // localStorage so Kyle can pin it open across reloads.
  const [debugHudVisible, setDebugHudVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      if (localStorage.getItem("__debugHudOpen") === "1") return true;
      const u = new URL(window.location.href);
      if (u.searchParams.get("debug") === "1") return true;
    } catch {
      // localStorage / URL parse failed; default to off.
    }
    return false;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Backtick (the key above Tab on US keyboards). Also accept ~ via
      // Shift+Backtick for convenience.
      if (e.key === "`" || (e.shiftKey && e.key === "~")) {
        e.preventDefault();
        setDebugHudVisible((v) => {
          const next = !v;
          try {
            localStorage.setItem("__debugHudOpen", next ? "1" : "0");
          } catch {
            // ignore — toggle still works in-session even if storage is blocked
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Publish engineLabel to window so DebugHud can read it.
  // (Effect runs after engineLabel updates.)
  useEffect(() => {
    if (engineLabel) (window as any).__engineLabel = engineLabel;
  }, [engineLabel]);
  const [hud, setHud] = useState<HudState>({
    connectionStatus: "offline",
    frame: 0,
    repeatedFrames: 0,
    hasRemote: false,
    hits: 0,
    bulletTime: false,
    localHp: 100,
    remoteHp: 100,
    localRespawningMs: 0,
    remoteRespawningMs: 0,
    isPointerLocked: false,
    everLocked: false,
    viewMode: 0,
    // PR 11.7.E / §3.5 — initial ammo = PLAYER_MAX_AMMO (matches the
    // server-side auto-register default). HUD reads server-authoritative
    // ammo via __latestSnap; this is just the pre-first-snapshot value.
    localAmmo: 6,
    reloadingUntilMs: null,
    // PR #108 — initial weapon state mirrors DualPistol + Semi
    // (the pre-PR-#108 behavior). The first 20Hz snapshot
    // arrival (within ~50ms of connect) overwrites these via
    // `_setLocalWeaponStateFromSnapshot` if the server's
    // authoritative state differs.
    weaponId: 0, // DualPistol
    fireModeIndex: 0, // Semi
    // PR #110 — no local fire held at page load; first tick
    // overwrites via `session.getFireHeld()`.
    fireHeld: false,
    // PR #115 (post-#114) — initial snapshot `isFiring`. The
    // first 20Hz tick overwrites via the localSnapPlayer read.
    isFiring: 0,
  });

  // PR 11.7.D2 / §3.10 — WebRTC peer / __peer / __smokeSignal /
  // __join probes REMOVED. The P2P lockstep signaling flow is
  // gone; the smoke uses `?server=` URL routing + the
  // ServerTransport DEV probes instead.

  // Stable callback so PeerOverlay's useEffect doesn't re-fire every render.
  const reportConnection = useCallback((s: HudState["connectionStatus"]) => {
    setHud((h) => (h.connectionStatus === s ? h : { ...h, connectionStatus: s }));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    // PR 11.7.D2 / §3.10 — no transport arg. The multiplayer scene
    // is enabled by the `?server=` URL flag (PeerOverlay.tsx reads
    // it on module load + sets `__forceServerTransport`). When set,
    // scene.ts wires ServerTransport + remoteInterpolator + remote
    // Havok controller. If unset, the scene is single-player.
    createScene(canvas)
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        setEngineLabel(handle.isWebGPU() ? "webgpu" : "webgl2");
        setPhase("ready");

        // Poll the runtime at ~10Hz for HUD display (avoids per-render React
        // re-renders from per-frame state updates).
        const hudTimer = window.setInterval(() => {
          // PR 11.7.D2 / fixes #50-verify: read chase state FIRST
          // (it's independent of gameSession — the pause menu /
          // pointer-lock UI needs it even in single-player mode).
          // The health + repeatedFrames + combatEvents reads below
          // remain gated on gameSession existence (single-player
          // has no gameSession; the values are multiplayer-only).
          //
          // PR 11.2: chase-camera state (pointer lock + menu orbit +
          // viewMode). Drives the pause-menu visibility. Single source
          // of truth: `handle.getChaseState?.()` returns a snapshot
          // read of the chase camera's internal flags.
          const chase = handle.getChaseState?.() ?? {
            isPointerLocked: false,
            isMenuOrbit: false,
            everLocked: false,
            viewMode: 0,
          };
          const session = handle.getGameSession?.();
          if (!session) {
            // Single-player path: keep chase-derived HUD fields live
            // (pointer lock, everLocked, viewMode) but skip the
            // multiplayer-only reads (HP, repeated frames, combat
            // events, bullet time).
            //
            // PR 11.7.D3+ / fix: `connectionStatus` is OWNED by
            // PeerOverlay (it polls `__serverTransport.getStats()`
            // at 200ms and reports up via `onStatusChange`). The
            // 10Hz HUD-timer MUST NOT clobber it back to "offline"
            // — pre-fix, every timer tick during multiplayer would
            // race PeerOverlay and reset the chip to "Offline"
            // whenever this single-player-fallback branch ran
            // (e.g. between scene init and gameSession mount, or
            // any future scene re-init). Root cause: this branch
            // treated `connectionStatus` like the other
            // multiplayer-only fields that DO need a reset to
            // defaults in single-player mode. Use `h.connectionStatus`
            // as the carrier so PeerOverlay's last-reported value
            // persists.
            setHud((h) => ({
              ...h,
              connectionStatus: h.connectionStatus,
              frame: 0,
              repeatedFrames: 0,
              hasRemote: false,
              hits: 0,
              bulletTime: false,
              localHp: 100,
              remoteHp: 100,
              localRespawningMs: 0,
              remoteRespawningMs: 0,
              isPointerLocked: chase.isPointerLocked,
              everLocked: chase.everLocked,
              viewMode: chase.viewMode,
            }));
            return;
          }
          // PR 7: pull the live InputState snapshot for the bullet-time chip.
          const inputState = handle.getInputState?.();
          // PR 10: pull the health snapshot so the HUD chip can render HP
          // + respawn countdown. Cheap read — just two field accesses.
          const health = session.getHealthSnapshot();
          // chase already declared above
          // PR 11.7.E / §3.5 — read local ammo + reload-progress
          // for the HUD. Ammo is server-authoritative (sourced from
          // the latest snapshot via `__latestSnap`); reload-progress
          // is client-local (`gameSession.getReloadingUntilMs`).
          // Both default to 0 / null when the snapshot / session
          // hasn't initialized yet (first ~50ms of connection).
          const snap = typeof window !== "undefined"
            ? (window as unknown as {__latestSnap?: () => { players: Array<{ playerId: number; ammo: number; isFiring?: number }> } | null}).__latestSnap?.() ?? null
            : null;
          const localSnapPlayer = snap
            ? snap.players.find((p) => p.playerId === session.localPlayerId)
            : null;
          const reloadingUntilMs = session.getReloadingUntilMs?.() ?? null;
          setHud((h) => ({
            ...h,
            frame: session.frame,
            repeatedFrames: session.repeatedFrameCount,
            hasRemote: session.runtime.hasRemote,
            hits: session.getCombatEvents().length,
            bulletTime: inputState?.bulletTimeHeld ?? false,
            localHp: health.local.hp,
            remoteHp: health.remote.hp,
            localRespawningMs: health.local.respawningMs,
            remoteRespawningMs: health.remote.respawningMs,
            localAmmo: localSnapPlayer ? localSnapPlayer.ammo : h.localAmmo,
            // PR #115 (post-#114) — local snapshot's `isFiring`
            // (server-authoritative). 0 or 1 wire-bool.
            isFiring: localSnapPlayer
              ? (localSnapPlayer.isFiring ?? 0)
              : h.isFiring,
            reloadingUntilMs,
            isPointerLocked: chase.isPointerLocked,
            everLocked: chase.everLocked,
            viewMode: chase.viewMode,
            // PR #108 — pull the optimistic local weapon state
            // from the GameSession (mirrors the snapshot's
            // authoritative values via `_setLocalWeaponStateFromSnapshot`).
            // Polling at 10Hz is the same cadence as the rest of
            // the HUD state above; the snapshot listener's
            // no-op-when-unchanged gate (in gameSession.ts)
            // prevents BulletHud re-renders on identical values.
            weaponId: session.getLocalWeaponState
              ? session.getLocalWeaponState().weaponId
              : h.weaponId,
            fireModeIndex: session.getLocalWeaponState
              ? session.getLocalWeaponState().fireModeIndex
              : h.fireModeIndex,
            // PR #110 — local fire-held flag for the Crosshair's
            // recoil-spread cue. Polled at the same 10Hz cadence as
            // the rest of the HUD state.
            fireHeld: session.getFireHeld ? session.getFireHeld() : h.fireHeld,
          }));
        }, 100);
        // Stash the timer on the scene ref so unmount can clear it.
        (handle as unknown as { __hudTimer: number }).__hudTimer = hudTimer;
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    return () => {
      disposed = true;
      const handle = sceneRef.current;
      if (handle) {
        const t = (handle as unknown as { __hudTimer?: number }).__hudTimer;
        if (t !== undefined) window.clearInterval(t);
        handle.dispose();
      }
      sceneRef.current = null;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        margin: 0,
        background: "#0a0a0c",
        color: "#e6e6e6",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          width: "100vw",
          height: "100vh",
          display: "block",
          outline: "none",
          touchAction: "none",
        }}
      />
      {phase === "loading" && (
        <OverlayBanner>Loading scene…</OverlayBanner>
      )}
      {phase === "error" && (
        <OverlayBanner color="#5a1a1a">
          Scene failed to start: {error}
        </OverlayBanner>
      )}
      {phase === "ready" && (
        <>
          <KeybindHud engineLabel={engineLabel} />
          {/* PR 11.7.D3 — Debug HUD overlay. Toggle with ` key. */}
          <DebugHud visible={debugHudVisible} />
          <BulletTimeChip active={hud.bulletTime} />
          {/* PR 11.7.D2 / §3.10 — PeerOverlay repurposed for server
              connection status (no peer). The overlay no longer
              drives SDP copy/paste; it surfaces the ServerTransport
              connect/disconnect lifecycle via the existing
              onStatusChange prop. */}
          <PeerOverlay onStatusChange={reportConnection} />
          <BulletHud
            frame={hud.frame}
            repeatedFrames={hud.repeatedFrames}
            connectionStatus={hud.connectionStatus}
            hasRemote={hud.hasRemote}
            hits={hud.hits}
            localHp={hud.localHp}
            remoteHp={hud.remoteHp}
            localRespawningMs={hud.localRespawningMs}
            remoteRespawningMs={hud.remoteRespawningMs}
            localAmmo={hud.localAmmo}
            maxAmmo={PLAYER_MAX_AMMO}
            reloadingUntilMs={hud.reloadingUntilMs}
            reloadProgressMs={1500}
            weaponId={hud.weaponId}
            fireModeIndex={hud.fireModeIndex}
            isFiring={hud.isFiring}
          />
          {/* PR #110 — center-screen weapon-aware crosshair.
              Reads weaponId/fireModeIndex/fireHeld from the same
              HudState that drives BulletHud (coherent data
              source). Renders nothing extra in dev — the crosshair
              is always on (even pre-pointer-lock) so the player
              can see their weapon state from the lobby. */}
          <Crosshair
            weaponId={hud.weaponId}
            fireModeIndex={hud.fireModeIndex}
            fireHeld={hud.fireHeld}
          />
          {/* PR 11.2: pause / loadout menu overlay. Visible when the
              pointer is unlocked AND the user has locked at least once
              (the `everLocked` gate prevents the menu from flashing on a
              fresh page). Resume closes the menu; Disconnect Peer closes
              the WebRTC connection. */}
          <PauseMenu
            visible={!hud.isPointerLocked && hud.everLocked}
            onResume={() => {
              // PR 11.2.3 DEBUG: log every Resume action (whether triggered
              // by the button click or by ESC-while-menu-visible — they
              // both funnel through here). Filter on "[PR-11.2.3-DEBUG]".
              if (typeof console !== "undefined") {
                console.log(
                  `[PR-11.2.3-DEBUG] App.onResume() t=${(performance.now() / 1000).toFixed(3)}s → calling handle.setPointerLock(true)`,
                );
              }
              const handle = sceneRef.current;
              if (!handle) return;
              handle.setPointerLock?.(true);
            }}
            onDisconnect={() => {
              // PR 11.7.D2 / §3.10 — close the ServerTransport.
              // The PeerOverlay surfaces the "disconnected" state
              // via its own interval; React state updates via
              // reportConnection. No peer to close.
              try {
                const t = sceneRef.current?.getServerTransport?.();
                // PR 11.7+ / AutoReconnect (Claude review B2) — this is a
                // user-initiated terminal close (PauseMenu "Disconnect
                // Peer" button). Use `dispose()`, not `close()`:
                // `close()` arms the auto-reconnect health-check, which
                // would re-connect the tab within ~1s of clicking the
                // button — exactly the opposite of what the user asked for.
                t?.dispose?.();
              } catch (e) {
                console.error("[pause-menu] server-transport dispose failed:", e);
              }
            }}
            viewMode={hud.viewMode}
          />
          <OverlayBanner bottom={16} size="0.7rem" opacity={0.35}>
            Phase 0 PR 11.2 — pause menu (ESC to resume · LMB fire · RMB melee · T bullet time) · WASD/Space/Shift/C/Q/V unchanged
          </OverlayBanner>
        </>
      )}
    </div>
  );
}

/**
 * PR 7: top-center chip that lights red while the local tab holds T.
 * Tiny chip — it's a status indicator, not a feature surface.
 */
function BulletTimeChip({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      data-testid="bullet-time-chip"
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "0.4rem 0.9rem",
        background: "rgba(154, 30, 30, 0.85)",
        color: "#fff",
        font: "bold 0.85rem ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        border: "1px solid rgba(255, 120, 120, 0.6)",
        borderRadius: "0.4rem",
        zIndex: 5,
        pointerEvents: "none",
        letterSpacing: "0.12em",
      }}
    >
      BULLET TIME
    </div>
  );
}

function KeybindHud({ engineLabel }: { engineLabel: "webgpu" | "webgl2" | null }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        padding: "0.6rem 0.9rem",
        background: "rgba(10, 10, 12, 0.72)",
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: "0.45rem",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "0.78rem",
        lineHeight: "1.45",
        color: "#e6e6e6",
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
        Specialists Web — PR 10 controls (PR 6+7 keymap unchanged)
      </div>
      <div><Key>W A S D</Key> walk</div>
      <div><Key>Space</Key> jump</div>
      <div><Key>Shift</Key> dive (tap while moving)</div>
      <div><Key>C</Key> slide (hold + move)</div>
      <div><Key>Q</Key> wallrun (tap mid-air)</div>
      <div><Key>V</Key> camera · third-person ↔ first-person</div>
      <div><Key>LMB</Key> fire dual pistols · <Key>RMB</Key> melee (1.5m cone) · <Key>T</Key> bullet time (0.25x, per-client)</div>
      {engineLabel && (
        <div style={{ marginTop: "0.4rem", opacity: 0.7 }}>
          renderer: {engineLabel}
        </div>
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "3.2rem",
        padding: "0 0.35rem",
        marginRight: "0.4rem",
        background: "rgba(230, 230, 230, 0.12)",
        border: "1px solid rgba(230, 230, 230, 0.25)",
        borderRadius: "0.25rem",
        textAlign: "center",
        fontSize: "0.72rem",
      }}
    >
      {children}
    </span>
  );
}

function OverlayBanner({
  children,
  color = "#0a0a0c",
  bottom = "50%",
  size = "0.95rem",
  opacity = 0.7,
}: {
  children: React.ReactNode;
  color?: string;
  bottom?: number | string;
  size?: string;
  opacity?: number;
}) {
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translate(-50%, -50%)",
        bottom,
        background: color,
        color: "#e6e6e6",
        padding: "0.5rem 0.9rem",
        borderRadius: "0.4rem",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: size,
        opacity,
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
}
