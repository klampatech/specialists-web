#!/usr/bin/env python3
"""
Real-user MacBook browser harness for the Specialists Web multiplayer FPS.

Drives N REAL chromium browser tabs through the real Lobby flow:
- Tab 0: open https://65.108.87.1:14432/, click "Create room", capture room code
- Tabs 1..N-1: open https://65.108.87.1:14432/, paste room code, click "Join"
- Wait for all tabs to enter the in-game state (server connected + scene rendered)
- Capture screenshots, dump body text, dump scene mesh state, verify count of remote rigs

This is the SAME harness used by subagents and the main session to verify fixes.
Tests MUST pass through the real Lobby UI. addInitScript hardcodes are forbidden.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from playwright.sync_api import sync_playwright, Page, Browser

MAC_USER = "kylelampa"
MAC_HOST = "100.79.235.118"
MAC_SSH_KEY = "/home/kyle/.ssh/id_macbook"

PROD_URL = "https://65.108.87.1:14432/"
SSH_BASE = ["ssh", "-i", MAC_SSH_KEY, "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=10", "-o", "IdentitiesOnly=yes",
            f"{MAC_USER}@{MAC_HOST}"]


def run_on_mac(cmd: str, timeout: int = 30) -> tuple[int, str]:
    """Run a command on the Mac and return (exit_code, stdout+stderr)."""
    full = SSH_BASE + [cmd]
    r = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def write_script_on_mac(script_text: str, dest: str = "/tmp/mac_harness.py") -> bool:
    """SCP a python script to the Mac and return True on success."""
    # Write to local temp file first, then scp (more reliable than stdin)
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write(script_text)
        local_path = f.name
    try:
        proc = subprocess.run(
            ["scp", "-i", MAC_SSH_KEY, "-o", "StrictHostKeyChecking=no",
             "-o", "ConnectTimeout=10", "-o", "IdentitiesOnly=yes",
             local_path, f"{MAC_USER}@{MAC_HOST}:{dest}"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            print(f"SCP failed: {proc.stderr}", file=__import__('sys').stderr)
        return proc.returncode == 0
    finally:
        try:
            os.unlink(local_path)
        except Exception:
            pass


def capture_screenshot_from_page(page: Page, path: str) -> None:
    page.screenshot(path=path, full_page=False)


def wait_for_in_game(page: Page, timeout_ms: int = 25000) -> bool:
    """Wait until the page shows 'Server: connected (websocket)' AND a frame > 50."""
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        try:
            body = page.locator("body").inner_text(timeout=2000)
        except Exception:
            time.sleep(0.3)
            continue
        m = re.search(r"frame:\s*(\d+)", body)
        if m and int(m.group(1)) > 50 and "connected (websocket)" in body.lower():
            return True
        time.sleep(0.4)
    return False


def dump_scene(page: Page) -> Dict[str, Any]:
    """Dump everything we'd want to inspect about the in-game scene."""
    return page.evaluate(r"""(() => {
        const session = window.__gameSession;
        if (!session) return {err: 'no gameSession'};
        const scene = session.remoteModel?.root?.getScene?.() ||
                      session.localModel?.root?.getScene?.();
        const cam = scene?.activeCamera;
        const snap = window.__latestSnap?.();
        const allMeshes = scene?.meshes ?? [];
        const visibleMeshes = allMeshes.filter(m => m.isVisible && m.isEnabled());
        const rigMeshes = visibleMeshes.filter(m => m.name && (
            m.name.includes('torso') || m.name.includes('head') ||
            m.name.includes('arm') || m.name.includes('leg')
        ));
        // Group by rig name (remote_*, local_*)
        const rigsByOwner = {};
        for (const m of rigMeshes) {
            const m2 = m.name;
            const owner = m2.startsWith('local_') ? 'local' :
                          m2.startsWith('remote_') ? 'remote' : 'unknown';
            rigsByOwner[owner] = (rigsByOwner[owner] || 0) + 1;
        }
        return {
            url: location.href,
            localPlayerId: window.__localPlayerId,
            peerPlayerId: window.__peerPlayerId,
            camPos: cam ? {x: cam.position.x, y: cam.position.y, z: cam.position.z} : null,
            camTarget: cam?.target ? {x: cam.target.x, y: cam.target.y, z: cam.target.z} : null,
            snapPlayers: snap?.players?.map(p => ({
                playerId: p.playerId, x: p.positionX, y: p.positionY,
                hp: p.hp, ammo: p.ammo, yaw: p.yaw, pitch: p.pitch,
            })) ?? null,
            rigMeshCount: rigMeshes.length,
            rigsByOwner,
            frame: (body => null)(null),  // filled in below
        };
    })()""")


def join_room_as_tab(page: Page, room_code: str, label: str) -> bool:
    """Open the lobby, paste room_code, click Join."""
    page.goto(PROD_URL, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(2000)
    # Find the Join input
    try:
        join_input = page.locator("input[placeholder*='code'], input[placeholder*='room'], input[type='text']").first
        join_input.fill(room_code)
    except Exception as e:
        print(f"  [{label}] join input fill failed: {e}")
        return False
    # Click Join button
    try:
        page.click("text=Join", timeout=3000)
    except Exception as e:
        print(f"  [{label}] Join click failed: {e}")
        return False
    return True


def create_room_as_tab(page: Page, label: str) -> Optional[str]:
    """Open the lobby, click Create room, extract the room code from the URL or body."""
    page.goto(PROD_URL, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(2000)
    try:
        page.click("text=Create room", timeout=3000)
    except Exception as e:
        print(f"  [{label}] Create click failed: {e}")
        return None
    # Wait for navigation
    page.wait_for_timeout(3000)
    # The room code is in the URL path: /rooms/<code>
    m = re.search(r"/rooms[/%]([A-Za-z0-9]+)", page.url)
    if m:
        return m.group(1)
    # Fallback: look at body for any visible room code text
    try:
        body = page.locator("body").inner_text(timeout=2000)
        m = re.search(r"\b[A-Z0-9]{6,}\b", body)
        if m:
            return m.group(0)
    except Exception:
        pass
    return None


# === RUN ON MAC ===

HARNESS_PY = r'''
import json
import re
import sys
import time
from playwright.sync_api import sync_playwright

PROD_URL = "https://65.108.87.1:14432/"


def wait_for_in_game(page, timeout_ms=30000):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            body = page.locator("body").inner_text(timeout=2000)
        except Exception:
            time.sleep(0.5); continue
        m = re.search(r"frame:\s*(\d+)", body)
        if m and int(m.group(1)) > 30 and "connected (websocket)" in body.lower():
            return True
        time.sleep(0.4)
    return False


def create_room(page, label):
    """Open the lobby, click Create room, wait for the room-code overlay,
    extract the code, click Continue, then return the code.
    """
    page.goto(PROD_URL, wait_until="domcontentloaded", timeout=20000)
    page.wait_for_timeout(2500)
    try:
        page.locator("[data-testid='lobby-create']").click(timeout=4000)
    except Exception as e:
        return None, f"create-click: {e}"
    # Wait for the room-code overlay (post-2026-09-06 UX)
    try:
        page.wait_for_selector("[data-testid='lobby-room-code']", timeout=10000)
    except Exception:
        # Fallback: pre-2026-09-06 behavior — direct navigation
        page.wait_for_timeout(3500)
        from urllib.parse import unquote, urlparse, parse_qs
        parsed = urlparse(page.url)
        qs = parse_qs(parsed.query)
        server_param = qs.get("server", [None])[0]
        code = None
        if server_param:
            m = re.search(r"/rooms/([A-Za-z0-9_-]+)", server_param)
            if m:
                code = m.group(1)
        if not code:
            decoded = unquote(page.url)
            m = re.search(r"rooms/([A-Za-z0-9_-]+)", decoded)
            if m:
                code = m.group(1)
        if not code:
            return None, f"no room code (no overlay + no url code): {page.url}"
        return code, None
    # Extract code from overlay
    code = page.locator("[data-testid='lobby-room-code']").inner_text().strip()
    # Click Continue
    try:
        page.locator("[data-testid='lobby-continue']").click(timeout=4000)
    except Exception as e:
        return code, f"continue-click: {e}"
    # Wait for navigation away from the lobby
    page.wait_for_timeout(3000)
    return code, None


def join_room(page, room_code, label):
    page.goto(PROD_URL, wait_until="domcontentloaded", timeout=20000)
    page.wait_for_timeout(2500)
    try:
        # Use the data-testid directly
        page.locator("[data-testid='lobby-code']").fill(room_code)
    except Exception as e:
        return False, f"input-fill: {e}"
    # Wait for the Join button to become enabled
    try:
        page.wait_for_selector("[data-testid='lobby-join']:not([disabled])", timeout=4000)
    except Exception:
        # Diagnose: is the input value visible?
        val = page.locator("[data-testid='lobby-code']").input_value()
        return False, f"join-still-disabled (input value={val!r})"
    try:
        page.locator("[data-testid='lobby-join']").click(timeout=4000)
    except Exception as e:
        return False, f"join-click: {e}"
    return True, None


def dump_state(page):
    return page.evaluate(r"""(() => {
        const s = window.__gameSession;
        if (!s) return {err: 'no gameSession'};
        const scene = s.remoteModel?.root?.getScene?.() || s.localModel?.root?.getScene?.();
        const cam = scene?.activeCamera;
        const snap = window.__latestSnap?.();
        const visibleMeshes = (scene?.meshes ?? []).filter(m => m.isVisible && m.isEnabled());
        const rigMeshes = visibleMeshes.filter(m => m.name && (
            m.name.includes('torso') || m.name.includes('head')
        ));
        const torsoPositions = rigMeshes.filter(m => m.name.includes('torso')).map(m => ({
            name: m.name,
            x: Math.round(m.absolutePosition.x * 10) / 10,
            y: Math.round(m.absolutePosition.y * 10) / 10,
            z: Math.round(m.absolutePosition.z * 10) / 10,
            parentName: m.parent?.name,
            parentX: m.parent?.position?.x,
            parentY: m.parent?.position?.y,
            parentZ: m.parent?.position?.z,
            isVisible: m.isVisible,
            isEnabled: m.isEnabled(),
            isReady: m.isReady?.(),
            isEnabledInActiveMesh: m.isInActiveMesh,
        }));
        return {
            url: location.href,
            localPlayerId: window.__localPlayerId,
            peerPlayerId: window.__peerPlayerId,
            camPos: cam ? {x: Math.round(cam.position.x*10)/10, y: Math.round(cam.position.y*10)/10, z: Math.round(cam.position.z*10)/10} : null,
            camTarget: cam?.target ? {x: Math.round(cam.target.x*10)/10, y: Math.round(cam.target.y*10)/10, z: Math.round(cam.target.z*10)/10} : null,
            snapPlayerIds: snap?.players?.map(p => p.playerId).sort((a,b)=>a-b) ?? null,
            snapPlayers: snap?.players?.map(p => ({
                playerId: p.playerId, x: Math.round(p.positionX*10)/10, y: Math.round(p.positionY*10)/10,
                hp: p.hp, ammo: p.ammo,
            })) ?? null,
            visibleMeshCount: visibleMeshes.length,
            torsoPositions,
            remoteRoot_pos: s.remoteModel?.root ? {x: Math.round(s.remoteModel.root.position.x*10)/10, y: Math.round(s.remoteModel.root.position.y*10)/10, z: Math.round(s.remoteModel.root.position.z*10)/10} : null,
            remoteVisualRoot_pos: s.remoteController?.visualRoot ? {x: Math.round(s.remoteController.visualRoot.position.x*10)/10, y: Math.round(s.remoteController.visualRoot.position.y*10)/10, z: Math.round(s.remoteController.visualRoot.position.z*10)/10} : null,
            remoteVisualRoot_isRoot: s.remoteController?.visualRoot === s.remoteModel?.root,
            lastSetPosition: window.__lastInterpolatorSetPosition ? JSON.stringify(window.__lastInterpolatorSetPosition) : null,
            liveHookSet: typeof window.__liveInterpolatorTickHook,
            bodyTextSnippet: (document.body.innerText || '').substring(0, 500),
        };
    })()""")


def fire_shot(page):
    """Fire a bullet from the local controller by triggering the AimEvent API.
    Uses gameSession.submitLocalInput or damageBus.sendAimEvent if exposed."""
    return page.evaluate(r"""(() => {
        const s = window.__gameSession;
        const bus = window.__damageBus;
        if (!s || !bus) return {err: 'no session/bus'};
        // Find a target — pick the lowest-id remote from snapshot that's not us
        const snap = window.__latestSnap?.();
        const myId = window.__localPlayerId;
        const target = (snap?.players ?? []).find(p => p.playerId !== myId);
        if (!target) return {err: 'no target'};
        // AimEvent: source=myId, target=target.playerId, hitPos={x: target.positionX, z: target.positionY, y: 1}
        try {
            const result = bus.sendAimEvent({
                serverFrame: (s.frame ?? 0) + 1,
                sourcePlayerId: myId,
                targetPlayerId: target.playerId,
                yawRadians: Math.atan2(target.positionX - s.localController.state.position.x, target.positionY - s.localController.state.position.z),
                pitchRadians: 0,
                hitPosX: target.positionX,
                hitPosY: target.positionY,
                hitPosZ: 1,
                weaponId: 0,
                damage: 12,
            });
            return {ok: true, targetId: target.playerId, result};
        } catch (e) {
            return {err: String(e)};
        }
    })()""")


def run(n_tabs, screenshot_prefix, wait_ms):
    results = {"tabs": [], "errors": []}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--ignore-certificate-errors", "--no-sandbox"])
        ctx = b.new_context(ignore_https_errors=True)
        pages = [ctx.new_page() for _ in range(n_tabs)]

        # Tab 0 creates the room
        code, err = create_room(pages[0], "tab0")
        if err:
            results["errors"].append(f"tab0-create: {err}")
            return results
        results["roomCode"] = code
        results["tabs"].append({"label": "tab0", "url": pages[0].url})

        # Tabs 1..n-1 join
        for i in range(1, n_tabs):
            ok, err = join_room(pages[i], code, f"tab{i}")
            if not ok:
                results["errors"].append(f"tab{i}-join: {err}")
            results["tabs"].append({"label": f"tab{i}", "url": pages[i].url, "joined": ok})

        # Wait for all to enter in-game
        for i, pg in enumerate(pages):
            in_game = wait_for_in_game(pg, timeout_ms=wait_ms)
            if not in_game:
                results["errors"].append(f"tab{i} did not enter in-game within {wait_ms}ms")
            results["tabs"][i]["inGame"] = in_game

        # Wait extra for snapshots to populate
        time.sleep(3)

        # Capture state from each tab
        for i, pg in enumerate(pages):
            try:
                state = dump_state(pg)
                results["tabs"][i]["state"] = state
            except Exception as e:
                results["tabs"][i]["state"] = {"err": str(e)}
            try:
                pg.screenshot(path=f"{screenshot_prefix}-tab{i}.png", full_page=False)
            except Exception as e:
                results["errors"].append(f"tab{i}-screenshot: {e}")

        # Fire a shot from tab0 at tab1's player
        shot_result = fire_shot(pages[0])
        results["shotFromTab0"] = shot_result

        # Wait for damage to propagate
        time.sleep(3)

        # State after the shot
        results["postShot"] = []
        for i, pg in enumerate(pages):
            try:
                results["postShot"].append(dump_state(pg))
            except Exception as e:
                results["postShot"].append({"err": str(e)})
            try:
                pg.screenshot(path=f"{screenshot_prefix}-postshot-tab{i}.png", full_page=False)
            except Exception:
                pass

        b.close()
    return results


if __name__ == "__main__":
    n_tabs = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    screenshot_prefix = sys.argv[2] if len(sys.argv) > 2 else "/tmp/mac"
    wait_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 30000
    out = run(n_tabs, screenshot_prefix, wait_ms)
    print("===MAC_HARNESS_RESULT===")
    print(json.dumps(out, indent=2, default=str))
'''


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tabs", type=int, default=2)
    ap.add_argument("--prefix", default="/tmp/mac")
    ap.add_argument("--wait-ms", type=int, default=30000)
    ap.add_argument("--local", action="store_true",
                    help="Run harness on this Linux box instead of Mac")
    args = ap.parse_args()

    if args.local:
        # Run directly on this box using local playwright
        from playwright.sync_api import sync_playwright
        # Reuse the same harness logic inline
        local_dir = Path("/tmp/mac-harness")
        local_dir.mkdir(exist_ok=True)
        out_path = local_dir / f"n{args.tabs}-result.json"
        # Use the harness as a python module
        script_path = Path("/tmp/mac_harness.py")
        if not script_path.exists():
            script_path.write_text(HARNESS_PY)
        env = os.environ.copy()
        env["PYTHONPATH"] = "/tmp"
        r = subprocess.run(["python3", str(script_path), str(args.tabs),
                            args.prefix, str(args.wait_ms)],
                           capture_output=True, text=True, env=env, timeout=180)
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        return r.returncode

    # Upload harness to Mac and run it
    if not write_script_on_mac(HARNESS_PY):
        print("ERROR: failed to upload harness to Mac", file=sys.stderr)
        return 2
    ssh_cmd = (f"python3 -u /tmp/mac_harness.py {args.tabs} {args.prefix} {args.wait_ms}")
    code, out = run_on_mac(ssh_cmd, timeout=240)
    sys.stdout.write(out)
    return code


if __name__ == "__main__":
    sys.exit(main())
