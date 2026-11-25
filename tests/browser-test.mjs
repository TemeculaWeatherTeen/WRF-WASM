// Drives the real page in headless Chrome with synthetic wrfout files: ?frames=... bypasses the model.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.argv[2] || "http://localhost:8765";
const shots = process.argv[3] || "/tmp/claude-0/shots";
import fs from "node:fs"; fs.mkdirSync(shots, { recursive: true });
const frames = [18,19,20,21,22,23].map((h) => `fx/wrfout_d01_2026-11-24_${h}:00:00.nc`).join(",");
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
const errors = [];
p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errors.push("console: " + m.text()); });
await p.goto(`${base}/index.html?frames=${encodeURIComponent(frames).replace(/%2C/g, ",")}`);
await p.waitForFunction(() => window.WRFApp?.frames.length === 6 && document.querySelectorAll("#field option").length > 20, null, { timeout: 15000 });
const t = (id) => p.textContent(id);
const check = (c, m) => { if (!c) { errors.push("FAIL: " + m); } else console.log("ok  ", m); };

check((await p.locator("#field option").count()) > 30, "variable menu lists many fields");
check((await p.locator("#field optgroup").count()) >= 4, "variables are grouped");
check((await t("#timeLabel")).includes("+0 h"), "first frame label shows +0 h");
await p.screenshot({ path: `${shots}/01-t2.png` });

await p.click("#next"); check((await t("#timeLabel")).includes("+1 h"), "next frame advances");
await p.fill("#frame", "5").catch(() => {}); await p.$eval("#frame", (e) => { e.value = 5; e.dispatchEvent(new Event("input")); });
check((await t("#timeLabel")).includes("+5 h"), "slider selects a frame");

check(!(await p.isVisible("#levelRow")), "level selector hidden for a surface field");
await p.selectOption("#field", "pcp_total"); await p.waitForTimeout(150);
check((await t("#legendUnit")).trim() === "in", "precip legend in inches (US units)");
await p.screenshot({ path: `${shots}/02-precip.png` });

await p.selectOption("#field", "wspd_p");
check(await p.isVisible("#levelRow"), "level selector appears for upper-air fields");
await p.selectOption("#level", "500"); await p.waitForTimeout(150);
check((await t("#legendUnit")).includes("500 hPa") && (await t("#legendUnit")).includes("mph"), "legend shows level and mph");
await p.screenshot({ path: `${shots}/03-wind500.png` });

await p.selectOption("#units", "si"); check((await t("#legendUnit")).includes("m/s"), "metric units switch");
await p.selectOption("#field", "refl_comp"); await p.waitForTimeout(100);
check(!(await p.isVisible("#levelRow")), "level selector hides again when switching back to a surface field");
await p.screenshot({ path: `${shots}/04-radar.png` });

// playback
await p.click("#first"); await p.selectOption("#speed", "110"); await p.click("#play");
await p.waitForTimeout(900);
const idx = await p.evaluate(() => window.WRFApp.idx); check(idx > 0, `playback advances frames (idx=${idx})`);
check((await t("#play")).includes("❚"), "play button shows pause while playing");
await p.click("#play");
const a = await p.evaluate(() => window.WRFApp.idx); await p.waitForTimeout(500);
check(a === (await p.evaluate(() => window.WRFApp.idx)), "pause stops playback");

// hover readout
await p.mouse.move(640, 300); await p.waitForTimeout(100);
check(await p.isVisible("#hover"), "hover readout shows over the grid");
console.log("hover:", await t("#hover"));
// panel position: bottom-left
const box = await p.locator("#panel").boundingBox();
check(box.x < 40 && box.y + box.height > 700, `panel sits bottom-left (x=${box.x|0}, bottom=${(box.y+box.height)|0})`);
await p.click("#collapse"); check(!(await p.isVisible("#field")), "panel collapses");
await p.click("#collapse");
// mobile
await p.setViewportSize({ width: 390, height: 780 }); await p.waitForTimeout(150);
await p.screenshot({ path: `${shots}/05-mobile.png` });
await b.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("browser test passed");
