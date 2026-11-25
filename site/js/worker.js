// Module worker: downloads the inputs, runs wrf.wasm, streams wrfout frames back to the page.
import { runWRF } from "./wrf-runner.js";

const fetchBytes = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

self.onmessage = async (ev) => {
  const { cmd, hours, base } = ev.data;
  if (cmd !== "run") return;
  try {
    const abs = (p) => new URL(p, base).href;
    self.postMessage({ type: "status", text: "Downloading model inputs" });
    const manifest = await (await fetch(abs("data/manifest.json"))).json();
    const [template, wrfinput, wrfbdy] = await Promise.all([
      fetch(abs(manifest.namelist)).then((r) => r.text()),
      fetchBytes(abs(manifest.input)),
      fetchBytes(abs(manifest.bdy)),
    ]);
    const files = { wrfinput_d01: wrfinput, wrfbdy_d01: wrfbdy };
    await Promise.all(manifest.run.map(async (n) => { files[n] = await fetchBytes(abs("data/run/" + n)); }));

    self.postMessage({ type: "status", text: "Loading wrf.wasm" });
    const { default: createWRF } = await import(abs("wasm/wrf.js"));

    self.postMessage({ type: "status", text: "Running WRF" });
    const res = await runWRF({
      createWRF, files, template, start: manifest.start, hours,
      onFrame: (name, bytes) => self.postMessage({ type: "frame", name, bytes }, [bytes.buffer]),
      onLog: (line) => self.postMessage({ type: "log", line }),
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    self.postMessage({ type: "done", ...res });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message ? e.message : e), stack: e && e.stack });
  }
};
