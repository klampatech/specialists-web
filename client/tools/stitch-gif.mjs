// Compose frames into an animated GIF using a headless browser + gifenc
import { chromium } from "playwright";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FRAME_DIR = "/tmp/cdp-screencast-v2";
const OUT_GIF = "/tmp/cdp-screencast-v2/composed.gif";

const files = readdirSync(FRAME_DIR)
  .filter((f) => f.endsWith("-A.png"))
  .sort();
const frameCount = files.length;
console.log(`${frameCount} A-frames found`);

if (frameCount === 0) {
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Read all PNGs as base64 data URLs
const allFrames = [];
for (let i = 0; i < frameCount; i++) {
  const a = readFileSync(join(FRAME_DIR, `frame-${String(i).padStart(3, "0")}-A.png`)).toString("base64");
  const b = readFileSync(join(FRAME_DIR, `frame-${String(i).padStart(3, "0")}-B.png`)).toString("base64");
  allFrames.push({ a: `data:image/png;base64,${a}`, b: `data:image/png;base64,${b}` });
}

const gifencSrc = readFileSync(
  "/home/kyle/Development/specialists-web-pr11.7-d2/client/node_modules/gifenc/dist/gifenc.esm.js",
  "utf8",
);

const gifBuffer = await page.evaluate(
  async ({ frames, gifencSrc }) => {
    const blob = new Blob([gifencSrc], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const gifenc = await import(url);

    const W = 640;
    const H = 360;
    const imgs = await Promise.all(
      frames.map(
        (f) =>
          new Promise((resolve) => {
            const a = new Image();
            const b = new Image();
            let loaded = 0;
            const check = () => {
              loaded++;
              if (loaded === 2) resolve({ a, b });
            };
            a.onload = check;
            b.onload = check;
            a.src = f.a;
            b.src = f.b;
          }),
      ),
    );

    const canvas = document.createElement("canvas");
    canvas.width = W * 2;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const enc = gifenc.GIFEncoder(W * 2, H, "rgb565");

    for (let i = 0; i < imgs.length; i++) {
      ctx.drawImage(imgs[i].a, 0, 0, W, H);
      ctx.drawImage(imgs[i].b, W, 0, W, H);
      const { data } = ctx.getImageData(0, 0, W * 2, H);
      const palette = gifenc.quantize(data, 256);
      const idx = gifenc.applyPalette(data, palette);
      enc.writeFrame(idx, W * 2, H, { palette, delay: 200 });
    }
    enc.finish();
    return Array.from(enc.bytes());
  },
  { frames: allFrames, gifencSrc },
);

writeFileSync(OUT_GIF, Buffer.from(gifBuffer));
console.log(`GIF written: ${OUT_GIF} (${gifBuffer.length} bytes)`);

await browser.close();