// Phase 0 / PR 4 — WebRTC peer overlay UI.
//
// The peer is owned by App.tsx and passed in as a prop. We surface:
//   - a status badge (data-testid="status") reflecting the current
//     connection state — "Waiting for room" / "Waiting for ICE…" /
//     "Connected" / "Disconnected" / etc.
//   - "Create Room" + "Join" buttons + a paste-an-answer textarea.
//
// On `peer.on("open")` the status flips to "Connected". On disconnect it
// flips to "Disconnected". The parent (App.tsx) mirrors the status into
// `BulletHud` so the bottom-left HUD chip stays in sync.

import { useEffect, useState } from "react";
import { WebRTCPeer } from "../net/peer";
import { decodePayload, encodePayload, joinBlob } from "../net/signaling";

interface PeerOverlayProps {
  peer: WebRTCPeer;
  /** Mirror the connection status up to App so BulletHud can show it. */
  onStatusChange?: (status: "offline" | "waiting-ice" | "connected" | "disconnected") => void;
}

/** Tracks whether the last-created blob was an offer or an answer, so the
 *  `data-testid` is unambiguous regardless of SDP body content. */
type BlobKind = "offer" | "answer";

export function PeerOverlay({ peer, onStatusChange }: PeerOverlayProps) {
  const [paste, setPaste] = useState("");
  const [blob, setBlob] = useState("");
  const [blobKind, setBlobKind] = useState<BlobKind | null>(null);
  const [status, setStatus] = useState<string>(
    typeof window !== "undefined" && joinBlob() ? "Joining from URL…" : "Waiting for room",
  );

  // Reflect peer lifecycle into the status badge + up to App.
  useEffect(() => {
    const off = (s: string) => {
      setStatus(s);
    };
    const onOpen = () => off("Connected");
    const onDisconnect = () => off("Disconnected");
    peer.on("open", onOpen);
    peer.on("disconnect", onDisconnect);
    return () => {
      // We don't unregister listeners — the peer is owned at the App level
      // for the mount lifetime.
    };
  }, [peer]);

  // Whenever the connection status string changes, classify it for the
  // parent's HUD chip + the BulletHud connection state.
  useEffect(() => {
    if (!onStatusChange) return;
    let s: "offline" | "waiting-ice" | "connected" | "disconnected" = "offline";
    if (status === "Connected") s = "connected";
    else if (status === "Disconnected") s = "disconnected";
    else if (status.includes("ICE") || status.includes("Joining")) s = "waiting-ice";
    else s = "offline";
    onStatusChange(s);
  }, [status, onStatusChange]);

  const create = async (): Promise<void> => {
    setStatus("Waiting for ICE…");
    try {
      const payload = await peer.createOffer();
      setBlob(encodePayload(payload));
      setBlobKind("offer");
      setStatus("ICE complete — copy offer blob");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not create offer");
    }
  };

  const join = async (): Promise<void> => {
    setStatus("Joining from URL…");
    try {
      const initial = paste || joinBlob() || "";
      const payload = await peer.createAnswer(decodePayload(initial));
      setBlob(encodePayload(payload));
      setBlobKind("answer");
      setStatus("ICE complete — copy answer blob");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not parse blob");
    }
  };

  const answer = async (): Promise<void> => {
    try {
      await peer.acceptAnswer(decodePayload(paste));
      setStatus("Waiting for connection…");
    } catch {
      setStatus("Could not parse — make sure you pasted the full blob");
    }
  };

  return (
    <div
      data-testid="peer-overlay"
      style={{
        position: "fixed",
        right: 16,
        top: 16,
        width: 310,
        padding: 12,
        background: "rgba(10, 10, 12, 0.82)",
        color: "#eee",
        font: "12px monospace",
        zIndex: 5,
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: 6,
      }}
    >
      <b>WebRTC peer bootstrap</b>
      <div data-testid="status" style={{ margin: "8px 0" }}>{status}</div>
      <button onClick={create} data-testid="btn-create">Create Room</button>
      <button onClick={join} style={{ marginLeft: 6 }} data-testid="btn-join">Join</button>
      <textarea
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder="Paste offer / answer"
        style={{ width: "100%", height: 55, marginTop: 8 }}
        data-testid="paste-area"
      />
      <button onClick={answer} data-testid="btn-paste-answer">Paste Answer</button>
      {blob && (
        <textarea
          data-testid={blobKind === "offer" ? "offer-blob" : "answer-blob"}
          readOnly
          value={blob}
          style={{ width: "100%", height: 55, marginTop: 8 }}
        />
      )}
    </div>
  );
}
