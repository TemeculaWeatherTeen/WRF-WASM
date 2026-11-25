// Exercises wrf-runner.js against a fake Emscripten module (no real wasm needed).
import assert from "node:assert/strict";
import fs from "node:fs";
import { runWRF, fillNamelist, parseSimTime } from "../site/js/wrf-runner.js";
import { Frame } from "../site/js/derive.js";

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const template = fs.readFileSync("tests/namelist.sample", "utf8");

// ---- namelist filling, including a day/month/year rollover
const filled = fillNamelist(template, "2026-12-31_18:00:00", 12);
ok(/start_year = 2026, start_month = 12, start_day = 31, start_hour = 18/.test(filled), "start date");
ok(/end_year = 2027, end_month = 01, end_day = 01, end_hour = 06/.test(filled), "end date rolls over the year");
ok(/run_hours = 12/.test(filled) && !/@@/.test(filled), "hours filled, no placeholders left");
ok(parseSimTime("Timing for main: time 2026-11-24_18:01:12 on domain   1:    0.41 elapsed seconds").toISOString() === "2026-11-24T18:01:12.000Z", "progress line parser");
ok(parseSimTime("something else") === null, "non-progress line ignored");

// ---- fake module: a tiny in-memory FS whose close() the runner hooks, like Emscripten's
const frameBytes = new Uint8Array(fs.readFileSync("tests/fixtures/wrfout_d01_2026-11-24_18:00:00.nc"));
function createFake({ fail = false } = {}) {
  const files = new Map(); let cwd = "/";
  const FS = {
    mkdir() {}, chdir(d) { cwd = d; },
    writeFile(n, b) { files.set(cwd + "/" + n, typeof b === "string" ? new TextEncoder().encode(b) : b); },
    readFile(p) { if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
    unlink(p) { files.delete(p); },
    readdir() { return [".", "..", ...[...files.keys()].map((k) => k.split("/").pop())]; },
    close(stream) { stream.closed = true; },
  };
  return async (opts) => ({
    FS, ENV: {},
    callMain() {
      const nl = new TextDecoder().decode(files.get("/run/namelist.input"));
      assert.ok(/run_hours = 3/.test(nl), "namelist reaches the module");
      assert.ok(files.has("/run/wrfinput_d01") && files.has("/run/RRTMG_LW_DATA"), "inputs staged in /run");
      for (let h = 0; h <= 3; h++) {
        const name = `wrfout_d01_2026-11-24_${18 + h}:00:00`;
        files.set("/run/" + name, new Uint8Array(16));           // WRF creates the file (header stub) ...
        FS.close({ path: "/run/" + name });                       // ... and closing a stub must not emit a frame
        files.set("/run/" + name, frameBytes.slice());            // then writes it for real
        FS.close({ path: "/run/" + name });                       // close => frame emitted + freed
        opts.print(`Timing for main: time 2026-11-24_${18 + h}:00:00 on domain   1:    0.5 elapsed seconds`);
      }
      FS.close({ path: "/run/wrfbdy_d01" });                      // unrelated files are ignored
      if (!fail) opts.print("d01 2026-11-24_21:00:00 wrf: SUCCESS COMPLETE WRF");
      return 0;
    },
  });
}

const got = [], prog = [];
const res = await runWRF({
  createWRF: createFake(), template, start: "2026-11-24_18:00:00", hours: 3,
  files: { wrfinput_d01: new Uint8Array(4), wrfbdy_d01: new Uint8Array(4), RRTMG_LW_DATA: new Uint8Array(4) },
  onFrame: (name, bytes) => got.push({ name, bytes }), onProgress: (p) => prog.push(p),
});
ok(res.success && res.exitCode === 0, "success detected from the WRF log line");
ok(got.length === 4 && res.frames === 4, "exactly four frames streamed (hours 0-3), stubs and other files skipped");
ok(got.every((g) => new Frame(g.bytes).nx === 53), "streamed bytes are valid wrfout files");
ok(prog.at(-1).simHours === 3 && prog.at(-1).steps === 4, "progress reports simulated hours");

const bad = await runWRF({ createWRF: createFake({ fail: true }), template, start: "2026-11-24_18:00:00", hours: 3,
  files: { wrfinput_d01: new Uint8Array(4), wrfbdy_d01: new Uint8Array(4), RRTMG_LW_DATA: new Uint8Array(4) } });
ok(!bad.success, "missing SUCCESS line is reported as failure");

console.log(`all ${n} runner checks passed`);
