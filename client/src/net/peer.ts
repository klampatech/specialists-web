import type {ClipboardPayload} from "./signaling";
type EventMap={open:void;packet:Uint8Array;disconnect:void};
const _isHeadless=()=>typeof navigator!=="undefined"&&navigator.userAgent.includes("HeadlessChrome");
const _forceRelay=()=>{try{return new URLSearchParams(window.location.search).get("turn")==="force"}catch{return false}};
const _useRelay=()=>_isHeadless()||_forceRelay();

/** Smoke-test signaling: store the offer/answer in localStorage so two tabs
 *  on the same origin can exchange SDP without copy-paste. Used only by the
 *  headless smoke test. The clipboard path (createOffer/createAnswer) is
 *  unchanged for human use. */
export function smokeSignalPut(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}
export function smokeSignalGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export class WebRTCPeer {
  readonly connection: RTCPeerConnection;
  private channels = new Map<string, RTCDataChannel>();
  private ls: {[K in keyof EventMap]?: Array<(v: EventMap[K]) => void>} = {};
  private candidates: RTCIceCandidateInit[] = [];
  private opened = new Set<string>();

  constructor() {
    this.connection = new RTCPeerConnection({
      iceServers: [
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelay" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelay" },
        { urls: "stun:stun.l.google.com:19302" },
      ],
      iceTransportPolicy: _useRelay() ? "relay" : "all",
    });
    this.connection.onicecandidate = (e) => {
      if (e.candidate) this.candidates.push(e.candidate.toJSON());
    };
    this.connection.ondatachannel = (e) => this.attach(e.channel);
    this.connection.onconnectionstatechange = () => {
      const s = this.connection.connectionState;
      if (["failed", "closed", "disconnected"].includes(s)) this.emit("disconnect", undefined);
    };
  }

  /** Wait for the underlying connection to reach a target state (e.g. "connected")
   *  or "failed"/"disconnected".  Resolves on target state; rejects on failure or
   *  after `timeoutMs`.  Use this instead of ICE-gathering-based waits since
   *  ICE can be slow and TURN servers may be unreachable in sandboxed envs. */
  waitForState(
    target: "connected" | "failed",
    timeoutMs = 45000,
  ): Promise<void> {
    const s = this.connection.connectionState;
    if (s === target) return Promise.resolve();
    if (s === "failed" || s === "closed" || s === "disconnected")
      return Promise.reject(new Error(`Connection ${s}`));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`waitForState(${target}) timeout`)), timeoutMs);
      this.connection.onconnectionstatechange = () => {
        const cs = this.connection.connectionState;
        clearTimeout(t);
        if (cs === target) resolve();
        else if (cs === "failed" || cs === "closed" || cs === "disconnected")
          reject(new Error(`Connection ${cs}`));
      };
    });
  }

  on<K extends keyof EventMap>(k: K, f: (v: EventMap[K]) => void) {
    const list = (this.ls[k] ??= []) as Array<(v: EventMap[K]) => void>;
    list.push(f);
  }

  private emit<K extends keyof EventMap>(k: K, v: EventMap[K]) {
    this.ls[k]?.forEach((f) => f(v));
  }

  private attach(c: RTCDataChannel) {
    this.channels.set(c.label, c);
    c.binaryType = "arraybuffer";
    c.onopen = () => {
      this.opened.add(c.label);
      if (this.opened.has("inputs") && this.opened.has("state")) this.emit("open", undefined);
    };
    c.onmessage = (e) => {
      if (c.label === "inputs") this.emit("packet", new Uint8Array(e.data));
    };
  }

  private channelsForHost() {
    this.attach(this.connection.createDataChannel("inputs", { ordered: true }));
    this.attach(this.connection.createDataChannel("state", { ordered: false, maxRetransmits: 0 }));
  }

  private async ice(): Promise<void> {
    if (this.connection.iceGatheringState === "complete") return;
    // TURN relay allocation can take up to ~15s in some sandboxed environments.
    // Increase timeout from 5s to 30s to account for TURN server response time.
    await new Promise<void>((r) => {
      const t = window.setTimeout(r, 30000);
      this.connection.onicegatheringstatechange = () => {
        if (this.connection.iceGatheringState === "complete") {
          clearTimeout(t);
          r();
        }
      };
    });
  }

  async createOffer(): Promise<ClipboardPayload> {
    console.log("[peer] createOffer called, state=", this.connection.connectionState);
    this.channelsForHost();
    await this.connection.setLocalDescription(await this.connection.createOffer());
    console.log("[peer] setLocalDescription done, state=", this.connection.connectionState);
    // Fire-and-forget ICE gather. The blob is returned immediately so the
    // clipboard signaling can begin; the caller can await ice() separately
    // if they need candidates bundled (not needed for clipboard flow).
    this.ice().catch(() => {});
    return { type: "offer", sdp: this.connection.localDescription!, candidates: [] };
  }

  async createAnswer(o: ClipboardPayload): Promise<ClipboardPayload> {
    console.log("[peer] createAnswer called, state=", this.connection.connectionState);
    await this.connection.setRemoteDescription(o.sdp);
    console.log("[peer] setRemoteDescription done, state=", this.connection.connectionState);
    for (const c of o.candidates) await this.connection.addIceCandidate(c);
    await this.connection.setLocalDescription(await this.connection.createAnswer());
    console.log("[peer] setLocalDescription done (answer), state=", this.connection.connectionState);
    // Fire-and-forget ICE gather — blob returned immediately.
    this.ice().catch(() => {});
    return { type: "answer", sdp: this.connection.localDescription!, candidates: [] };
  }

  async acceptAnswer(a: ClipboardPayload): Promise<void> {
    try {
      console.log("[peer] acceptAnswer called, state=", this.connection.connectionState);
      await this.connection.setRemoteDescription(a.sdp);
      console.log("[peer] acceptAnswer setRemoteDescription done, state=", this.connection.connectionState);
      for (const c of a.candidates) await this.connection.addIceCandidate(c);
    } catch (e) {
      console.error("[acceptAnswer] setRemoteDescription failed:", e);
      throw e;
    }
  }

  send(k: "inputs" | "state", b: Uint8Array) {
    const c = this.channels.get(k);
    if (c?.readyState === "open") c.send(b.buffer as ArrayBuffer);
  }

  close() {
    this.connection.close();
  }
}
