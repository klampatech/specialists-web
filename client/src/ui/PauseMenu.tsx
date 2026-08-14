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
  // PR 11.2: ESC-equals-resume. The input listener already calls
  // `chase.setPointerLock(true)` on ESC when unlocked; this effect just
  // makes the React side aware of that for the document-level handler.
  // (We re-bind here as a belt-and-suspenders fallback — the smoke drives
  // the pause menu via `__pointerLockToggle` and could click Resume even
  // if the input listener's onEscapePressed hook hasn't fired yet.)
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.repeat) {
        e.preventDefault();
        onResume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
