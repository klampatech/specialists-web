import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const result = await page.evaluate(async () => {
  if (typeof WebTransport === "undefined") return { wt: "undef" };
  try {
    const wt = new WebTransport("https://m5.tail1b3795.ts.net:14433/rooms/DEVBX");
    const r = await Promise.race([
      wt.ready.then(() => "OK").catch(e => e.name + ": " + e.message),
      new Promise(rr => setTimeout(() => rr("timeout"), 8000))
    ]);
    wt.close();
    return { wt: r };
  } catch (e) {
    return { wt: "thrown: " + e.name + ": " + e.message };
  }
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
