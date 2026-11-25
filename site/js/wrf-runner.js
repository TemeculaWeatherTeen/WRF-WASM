// Runs the wasm build of wrf.exe. Used by the browser worker and by the Node smoke test,
// so both exercise exactly the same code path.
//
//   createWRF   the default export of wasm/wrf.js (Emscripten MODULARIZE + EXPORT_ES6)
//   files       { name: Uint8Array }  everything wrf.exe expects in its working directory, except namelist.input
//   template    text of namelist.input.template
//   start       "YYYY-MM-DD_HH:00:00"
//   hours       forecast length

export function fillNamelist(template, start, hours) {
  const t = new Date(start.replace("_", "T") + "Z");
  const e = new Date(t.getTime() + hours * 3600e3);
  const p2 = (n) => String(n).padStart(2, "0");
  const parts = (d) => ({ Y: String(d.getUTCFullYear()), M: p2(d.getUTCMonth() + 1), D: p2(d.getUTCDate()), H: p2(d.getUTCHours()) });
  const s = parts(t), en = parts(e);
  const vals = {
    RUN_HOURS: String(hours),
    SY: s.Y, SM: s.M, SD: s.D, SH: s.H,
    EY: en.Y, EM: en.M, ED: en.D, EH: en.H,
  };
  return template.replace(/@@(\w+)@@/g, (_, k) => vals[k]);
}

export function parseSimTime(line) {
  const m = /Timing for main: time (\d{4}-\d\d-\d\d_\d\d:\d\d:\d\d) on domain/.exec(line);
  return m ? new Date(m[1].replace("_", "T") + "Z") : null;
}

export async function runWRF({ createWRF, files, template, start, hours, onFrame, onLog, onProgress }) {
  const t0 = new Date(start.replace("_", "T") + "Z").getTime();
  const tail = [];
  let success = false;
  let steps = 0;

  const handle = (line) => {
    tail.push(line);
    if (tail.length > 300) tail.shift();
    if (/SUCCESS COMPLETE WRF/.test(line)) success = true;
    const sim = parseSimTime(line);
    if (sim) {
      steps++;
      onProgress?.({ simHours: (sim.getTime() - t0) / 3600e3, hours, steps });
    }
    onLog?.(line);
  };

  const mod = await createWRF({ print: handle, printErr: handle, noInitialRun: true });
  const FS = mod.FS;

  // The flang runtime reads this to byte-swap the big-endian RRTMG/RRTM data files.
  if (mod.ENV) mod.ENV.FORT_CONVERT = "BIG_ENDIAN";

  FS.mkdir("/run");
  FS.chdir("/run");
  for (const [name, bytes] of Object.entries(files)) FS.writeFile(name, bytes);
  FS.writeFile("namelist.input", fillNamelist(template, start, hours));

  // Hand each wrfout frame to the caller the moment WRF closes it, then free its memory.
  const sent = new Set();
  const flush = (path) => {
    const base = path.split("/").pop();
    if (!/^wrfout_d01_/.test(base) || sent.has(base)) return;
    let bytes;
    try { bytes = FS.readFile(path).slice(); } catch { return; }
    if (bytes.length < 1024) return; // header-only stub from file creation
    sent.add(base);
    onFrame?.(base, bytes);
    try { FS.unlink(path); } catch { /* ignore */ }
  };
  const origClose = FS.close.bind(FS);
  FS.close = (stream) => {
    const p = stream && stream.path;
    origClose(stream);
    if (p) flush(p);
  };

  let exitCode = null;
  try {
    exitCode = mod.callMain([]);
  } catch (e) {
    if (e && e.name === "ExitStatus") exitCode = e.status;
    else { handle("JS exception: " + (e && e.stack ? e.stack : e)); throw e; }
  }
  for (const f of FS.readdir("/run")) flush("/run/" + f);

  return { success, exitCode, frames: sent.size, steps, tail };
}
