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

  /**
   * Wait for ICE gathering to settle (or until `timeoutMs` elapses, whichever
   * comes first). Pushes every gathered candidate into `this.candidates` via
   * the `onicecandidate` handler, so callers can serialize the array into
   * the next offer/answer blob. Returns the number of candidates gathered
   * — callers can use this for telemetry / status messages.
   *
   * **Why the timeout matters**: TURN allocation can take 5-15s in some
   * networks; we want the caller's `await` to return even if gathering
   * is still in progress, so they get the candidates gathered so far and
   * can proceed with the copy-paste dance. Candidates that arrive AFTER
   * the timeout are dropped (the user would have to do a second paste
   * — see PeerOverlay's "Gathering ICE…" status).
   */
  private async ice(timeoutMs = 5000): Promise<number> {
    if (this.connection.iceGatheringState === "complete") return this.candidates.length;
    return new Promise<number>((resolve) => {
      const t = window.setTimeout(() => {
        resolve(this.candidates.length);
      }, timeoutMs);
      this.connection.onicegatheringstatechange = () => {
        if (this.connection.iceGatheringState === "complete") {
          window.clearTimeout(t);
          resolve(this.candidates.length);
        }
      };
    });
  }

  async createOffer(): Promise<ClipboardPayload> {
    console.log("[peer] createOffer called, state=", this.connection.connectionState);
    this.channelsForHost();
    await this.connection.setLocalDescription(await this.connection.createOffer());
    console.log("[peer] setLocalDescription done, state=", this.connection.connectionState);
    // PR 10.1: await ICE gathering (up to 5s) so the bundled candidates get
    // serialized into the offer blob. Without this, the peer's
    // `createAnswer` has no candidates to addIceCandidate — the host's
    // host-reflexive (srflx) candidates get stranded in `this.candidates`
    // and the connection only completes when the SDP itself contains
    // every needed candidate (LAN, TURN-reflexive-in-SDP). Real two-tab
    // playtest over Tailscale or non-TURN-reachable networks fails.
    const gathered = await this.ice();
    console.log("[peer] createOffer: gathered", gathered, "candidates");
    return { type: "offer", sdp: this.connection.localDescription!, candidates: [...this.candidates] };
  }

  async createAnswer(o: ClipboardPayload): Promise<ClipboardPayload> {
    console.log("[peer] createAnswer called, state=", this.connection.connectionState);
    await this.connection.setRemoteDescription(o.sdp);
    console.log("[peer] setRemoteDescription done, state=", this.connection.connectionState);
    for (const c of o.candidates) await this.connection.addIceCandidate(c);
    await this.connection.setLocalDescription(await this.connection.createAnswer());
    console.log("[peer] setLocalDescription done (answer), state=", this.connection.connectionState);
    // PR 10.1: same fix as createOffer — await ICE gathering so the
    // bundled candidates ship in the answer blob. `acceptAnswer` on the
    // host reads them and addIceCandidate's them on the host's connection.
    const gathered = await this.ice();
    console.log("[peer] createAnswer: gathered", gathered, "candidates");
    return { type: "answer", sdp: this.connection.localDescription!, candidates: [...this.candidates] };
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
