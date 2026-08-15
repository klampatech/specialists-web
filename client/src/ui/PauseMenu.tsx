// Phase 0 / PR 11.2 — pause / loadout menu overlay.
//
// Shown when `pointerLocked === false && everLocked === true` (mirrors
// `chase.isMenuOrbit()` exactly — see `chaseCamera.ts:319`). The cursor
// unlocks into this menu so the user has something to interact with;
// the menu orbit camera (PR 11.1.2) keeps the world alive in the background.
//
// PR 11.2 design notes:
//
// 1. **Buttons are real `<button>` elements** — keyboard-accessible by
//    default (Enter/Space activate), have built-in focus indicators.
//    Other HUD chips stay `pointer-events: none` (PR 7 lesson) but the
//    menu backdrop is `pointer-events: auto` so clicks reach the buttons.
// 2. **Resume is the primary affordance** — keyboard shortcuts are
//    documented in the bottom-hint line; the visible Resume button stays
//    for accessibility (laptops without dedicated Escape, screen readers,
//    dev-box users who haven't read the hint yet).
// 3. **Disconnect Peer** calls `peer.close()` — re-host / re-join is
//    PeerOverlay's job, kept separate.
// 4. **No animation** — `null` vs rendered. PR 11.2 is functional, not
//    visual polish. Fade-in is a 5-line follow-up if Kyle wants it.
//
// PR 11.2.1 fix (Kyle playtest 2026-08-14): The pause menu does NOT
// own a keydown listener for ESC. Two listeners firing on the same
// keydown (inputListener.ts + PauseMenu's useEffect) caused a race where
// the browser fired a follow-up `pointerlockchange(false)` immediately
// after our `requestPointerLock()` succeeded, causing the menu to flash
// and reappear. The single source of truth was `inputListener.ts`'s
// `onEscapePressed` hook.
//
// PR 11.2.2 fix (Kyle playtest 2026-08-14 session): REMOVED the
// inputListener ESC handler entirely. Now:
//   - When menu is visible (pointer unlocked): PauseMenu's own keydown
//     listener catches ESC and calls onResume() — single handler, no race.
//   - When menu is NOT visible (pointer locked): browser natively fires
//     pointerlockchange(false) on ESC, which the chase camera handles
//     through onPointerLockChange → setPointerLock(false). No double-fire.
//
// PR 11.2.1 note above is WRONG — kept as historical record.

import { useEffect } from "react";

interface PauseMenuProps {
  /** True when the menu should be visible. */
  visible: boolean;
  /** Re-locks the pointer (closes the menu, returns to gameplay). */
  onResume: () => void;
  /** Closes the WebRTC peer connection. */
  onDisconnect: () => void;
  /** Current viewMode (0 first-person, 1 over-shoulder) — shown as a
   *  hint next to the Resume button so the user knows which camera
   *  they'll return to. Optional — falls back to "your last view". */
  viewMode?: number;
}

export function PauseMenu({ visible, onResume, onDisconnect, viewMode }: PauseMenuProps) {
  // PR 11.2.2 fix: When menu is visible, catch ESC here and call
  // onResume() directly. This is the SOLE ESC handler for the menu-visible
  // case — no more race with inputListener. When the menu is NOT visible,
  // the browser handles ESC natively (pointerlockchange(false) fires,
  // which the chase camera handles through onPointerLockChange).
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.repeat) {
        e.preventDefault();
        // PR 11.2.3 DEBUG: log every menu-visible ESC keydown with
        // timestamp + the chase camera's lock state at that moment.
        // Filter on "[PR-11.2.3-DEBUG]" in DevTools.
        if (typeof console !== "undefined") {
          console.log(
            `[PR-11.2.3-DEBUG] PauseMenu keydown(Escape) t=${(performance.now() / 1000).toFixed(3)}s visible=${visible} → calling onResume()`,
          );
        }
        onResume();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, onResume]);

  if (!visible) return null;

  const cameraLabel =
    viewMode === 1
      ? "over-shoulder"
      : viewMode === 0
        ? "first-person"
        : "your last view";

  return (
    <div
      data-testid="pause-menu"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8, 8, 10, 0.78)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.5rem",
        // PR 11.2: backdrop MUST be the click target (PR 7 HUD-overlay
        // bug). Children (buttons) explicitly re-enable pointer-events
        // below — they're auto by default for native <button>, so this
        // is belt-and-suspenders.
        pointerEvents: "auto",
        cursor: "default",
        zIndex: 50,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "#e6e6e6",
      }}
    >
      <div
        style={{
          fontSize: "1.4rem",
          fontWeight: 600,
          letterSpacing: "0.18em",
          marginBottom: "0.5rem",
          textTransform: "uppercase",
          opacity: 0.92,
        }}
      >
        Paused
      </div>
      <MenuButton
        testId="pause-menu-resume"
        label="Resume"
        subtitle={`press ESC · return to ${cameraLabel}`}
        onClick={onResume}
        primary
      />
      <MenuButton
        testId="pause-menu-loadout"
        label="Loadout"
        subtitle="coming soon"
        disabled
      />
      <MenuButton
        testId="pause-menu-settings"
        label="Settings"
        subtitle="coming soon"
        disabled
      />
      <MenuButton
        testId="pause-menu-disconnect"
        label="Disconnect Peer"
        subtitle="close the WebRTC connection"
        onClick={onDisconnect}
      />
    </div>
  );
}

/** A single menu button — native <button> for keyboard accessibility,
 *  with a primary-state visual distinction. */
function MenuButton({
  testId,
  label,
  subtitle,
  onClick,
  disabled,
  primary,
}: {
  testId: string;
  label: string;
  subtitle?: string;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        // 280px wide so the menu reads as a vertical stack, not scattered.
        width: "min(280px, 80vw)",
        padding: "0.7rem 1.1rem",
        background: primary
          ? "rgba(230, 230, 230, 0.94)"
          : "rgba(20, 20, 24, 0.78)",
        color: primary ? "#0a0a0c" : "#e6e6e6",
        border: primary
          ? "1px solid rgba(255, 255, 255, 0.4)"
          : "1px solid rgba(230, 230, 230, 0.32)",
        borderRadius: "0.45rem",
        fontSize: "0.95rem",
        fontWeight: primary ? 700 : 500,
        letterSpacing: "0.08em",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.42 : 1,
        // PR 11.2: explicit `auto` because the parent is `auto` too and
        // we want belt-and-suspenders against any future
        // `pointer-events: none` cascade. Also makes the testids reachable
        // for `page.click()` even if someone later adds a wrapper div
        // with `pointer-events: none`.
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "0.15rem",
      }}
    >
      <span>{label}</span>
      {subtitle && (
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 400,
            opacity: primary ? 0.7 : 0.55,
            letterSpacing: "0.04em",
          }}
        >
          {subtitle}
        </span>
      )}
    </button>
  );
}
