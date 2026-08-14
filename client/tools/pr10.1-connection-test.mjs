// PR 10.1 diagnostic: drive the full SDP dance, then wait 15s for
// connectionState to reach "connected". Logs every state transition.
// This is the test the PR 6 smoke skips — it proves the candidate
// bundling actually produces a usable connection.

import { chromium } from "playwright";

const URL = "http://localhost:5173/";
const URL_GUEST = "http://localhost:5174/";

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext({ viewport: { width: 1024, height: 720 } });
const contextB = await browser.newContext({ viewport: { width: 1024, height: 720 } });
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();

pageA.on("console", (m) => console.log(`[A ${m.type()}]`, m.text()));
pageB.on("console", (m) => console.log(`[B ${m.type()}]`, m.text()));

console.log("Loading both pages...");
await pageA.goto(URL, { waitUntil: "networkidle" });
await pageB.goto(URL_GUEST, { waitUntil: "networkidle" });
await pageA.waitForFunction(() => !document.body.textContent.includes("Loading scene"), { timeout: 15000 });
await pageB.waitForFunction(() => !document.body.textContent.includes("Loading scene"), { timeout: 15000 });

console.log("Tab A: clicking Create Room...");
await pageA.click('[data-testid="btn-create"]');
await pageA.waitForFunction(
  () => {
    const t = document.querySelector('[data-testid="offer-blob"]');
    return t && t.value && t.value.length > 100;
  },
  { timeout: 15000 },
);
const offer = await pageA.locator('[data-testid="offer-blob"]').inputValue();
console.log("Offer length:", offer.length, "chars");

console.log("Tab B: pasting offer, clicking Join...");
await pageB.locator('[data-testid="paste-area"]').fill(offer);
await pageB.click('[data-testid="btn-join"]');
await pageB.waitForFunction(
  () => {
    const t = document.querySelector('[data-testid="answer-blob"]');
    return t && t.value && t.value.length > 100;
  },
  { timeout: 15000 },
);
const answer = await pageB.locator('[data-testid="answer-blob"]').inputValue();
console.log("Answer length:", answer.length, "chars");

console.log("Tab A: pasting answer, clicking Paste Answer...");
await pageA.locator('[data-testid="paste-area"]').fill(answer);
await pageA.click('[data-testid="btn-paste-answer"]');

// Wait up to 15s for connection state to reach "connected" on either side.
console.log("Waiting up to 15s for connection state to reach 'connected'...");
const deadline = Date.now() + 15000;
let connectedA = false;
let connectedB = false;
let lastStateA = "?";
let lastStateB = "?";
while (Date.now() < deadline && !(connectedA && connectedB)) {
  const stateA = await pageA.evaluate(() => window.__peer?.connection?.connectionState ?? "?");
  const stateB = await pageB.evaluate(() => window.__peer?.connection?.connectionState ?? "?");
  if (stateA !== lastStateA || stateB !== lastStateB) {
    console.log(`  state: A=${stateA} B=${stateB} (t=${((deadline - Date.now())/1000).toFixed(1)}s left)`);
    lastStateA = stateA;
    lastStateB = stateB;
  }
  if (stateA === "connected") connectedA = true;
  if (stateB === "connected") connectedB = true;
  if (!connectedA || !connectedB) await new Promise(r => setTimeout(r, 500));
}

console.log("");
console.log("=== FINAL ===");
console.log(`A: connectionState=${lastStateA}  (connected? ${connectedA})`);
console.log(`B: connectionState=${lastStateB}  (connected? ${connectedB})`);

if (connectedA && connectedB) {
  console.log("OK WebRTC connection established end-to-end");
  process.exit(0);
} else {
  console.log("FAIL Connection did NOT establish within 15s");
  // Dump candidate stats for diagnosis
  const statsA = await pageA.evaluate(async () => {
    const s = await window.__peer.connection.getStats();
    const out = [];
    for (const r of s.values()) {
      if (r.type === 'candidate-pair' || r.type === 'local-candidate' || r.type === 'remote-candidate') {
        out.push({ type: r.type, state: r.state, candidateType: r.candidateType, address: r.address, port: r.port });
      }
    }
    return out;
  });
  console.log("Tab A candidates:", JSON.stringify(statsA, null, 2));
  process.exit(1);
}
