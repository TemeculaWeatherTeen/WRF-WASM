// CI smoke test: run the freshly built wrf.wasm for a few forecast hours under Node and sanity-check the output.
//   node scripts/wasm/node-smoke.mjs <public dir> [hours]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWRF } from "../../site/js/wrf-runner.js";
import { parseNetCDF } from "../../site/js/netcdf.js";

const pub = path.resolve(process.argv[2] || "public");
const hours = Number(process.argv[3] || 1);
const manifest = JSON.parse(fs.readFileSync(path.join(pub, "data/manifest.json"), "utf8"));
const rd = (p) => new Uint8Array(fs.readFileSync(path.join(pub, p)));

const files = { wrfinput_d01: rd(manifest.input), wrfbdy_d01: rd(manifest.bdy) };
for (const n of manifest.run) files[n] = rd("data/run/" + n);
const template = fs.readFileSync(path.join(pub, manifest.namelist), "utf8");

const { default: createWRF } = await import(pathToFileURL(path.join(pub, "wasm/wrf.js")).href);

const frames = [];
const t0 = Date.now();
const res = await runWRF({
  createWRF, files, template, start: manifest.start, hours,
  onFrame: (name, bytes) => { frames.push({ name, bytes }); console.log("frame", name, bytes.length); },
  onLog: (l) => { if (/Timing for main|ERROR|FATAL|forrtl|error/i.test(l)) console.log(l); },
});
console.log(`exit=${res.exitCode} success=${res.success} frames=${res.frames} steps=${res.steps} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

let bad = [];
if (!res.success) bad.push("WRF did not print SUCCESS COMPLETE WRF");
if (frames.length < hours + 1) bad.push(`expected ${hours + 1} frames, got ${frames.length}`);
if (frames.length) {
  const nc = parseNetCDF(frames[frames.length - 1].bytes);
  const t2 = nc.read("T2");
  const lo = Math.min(...t2), hi = Math.max(...t2);
  console.log(`T2 range ${lo.toFixed(1)}..${hi.toFixed(1)} K`);
  if (!(lo > 230 && hi < 340) || Number.isNaN(lo)) bad.push("T2 outside plausible range");
}
if (bad.length) { console.error("SMOKE TEST FAILED:\n - " + bad.join("\n - ")); console.error(res.tail.slice(-40).join("\n")); process.exit(1); }
console.log("smoke test passed");
