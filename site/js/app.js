import { Frame, availableFields, computeField, computeVectors, autoRange, PRESSURE_LEVELS } from "./derive.js";
import { gridGeometry, paintField, paintVectors, sample, cmapCss } from "./render.js";
import { createMap } from "./mapview.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const S = {
  frames: [],          // Frame[], sorted by valid time
  fields: [],          // availableFields() for the current run
  fieldId: params.get("field") || "t2",
  level: 500,
  idx: 0,
  units: "us",
  playing: false,
  timer: null,
  worker: null,
  manifest: null,
  grid: null,
  map: null,
  current: null,       // {data, field} last painted, for hover
  rangeCache: new Map(),
};
window.WRFApp = S; // handy for debugging and tests

// ------------------------------------------------------------------ helpers
const fmtLocal = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const pad = (n) => String(n).padStart(2, "0");
const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));
const fieldById = (id) => S.fields.find((f) => f.id === id);

function setStatus(t) { $("status").textContent = t; }
function log(line) { const el = $("log"); el.textContent += line + "\n"; if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000); el.scrollTop = el.scrollHeight; }

// ------------------------------------------------------------------ frames
function addFrame(bytes) {
  const f = new Frame(bytes);
  if (S.frames.some((x) => x.timeStr === f.timeStr)) return null;
  S.frames.push(f);
  S.frames.sort((a, b) => a.time - b.time);
  if (!S.grid) {
    S.grid = gridGeometry(f);
    S.map = createMap($("map"), S.grid.bounds);
    S.map.onMove(onHover);
    $("opacity").dispatchEvent(new Event("input"));
  }
  if (S.frames.length === 1) buildFieldMenu(f);
  $("frame").max = String(S.frames.length - 1);
  return f;
}

function buildFieldMenu(frame) {
  S.fields = availableFields(frame);
  const sel = $("field"); sel.textContent = "";
  const groups = new Map();
  for (const f of S.fields) {
    if (!groups.has(f.group)) { const og = document.createElement("optgroup"); og.label = f.group; groups.set(f.group, og); sel.appendChild(og); }
    const o = document.createElement("option"); o.value = f.id; o.textContent = f.label; groups.get(f.group).appendChild(o);
  }
  if (!fieldById(S.fieldId)) S.fieldId = S.fields[0].id;
  sel.value = S.fieldId;
  const lv = $("level"); lv.textContent = "";
  for (const p of PRESSURE_LEVELS) { const o = document.createElement("option"); o.value = p; o.textContent = `${p} hPa`; lv.appendChild(o); }
  lv.value = S.level;
  $("levelRow").hidden = !fieldById(S.fieldId).level;
}

// ------------------------------------------------------------------ drawing
function rangeFor(field) {
  const level = field.level ? S.level : "";
  const key = `${field.id}:${level}:${S.frames.length}`;
  if (S.rangeCache.has(key)) return S.rangeCache.get(key);
  const arrays = S.frames.map((f, i) => computeField(f, field, S.level, S.frames[i - 1]));
  let r;
  if (field.range) r = field.range;
  else if (field.symmetric) { const [lo, hi] = autoRange(arrays); const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; r = [-m, m]; }
  else if (field.transparentBelow !== undefined) {
    let hi = 0; for (const a of arrays) for (let i = 0; i < a.length; i++) if (a[i] > hi) hi = a[i];
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(hi, 1e-6)))) ;
    r = [0, hi <= 0 ? 1 : Math.ceil(hi / step) * step];
  } else r = autoRange(arrays);
  S.rangeCache.set(key, r);
  return r;
}

function draw() {
  if (!S.frames.length) return;
  const field = fieldById(S.fieldId);
  if (!field) return;
  const frame = S.frames[S.idx], prev = S.frames[S.idx - 1];
  const data = computeField(frame, field, S.level, prev);
  const range = rangeFor(field);
  const canvas = draw.c1 ||= document.createElement("canvas");
  paintField(canvas, data, frame.nx, frame.ny, { cmap: field.cmap, range, transparentBelow: field.transparentBelow });
  S.map.setImage("field", canvas.toDataURL("image/png"));

  const vec = $("vectors").checked ? computeVectors(frame, field, S.level) || (S.fields.length ? computeVectors(frame, fieldById("wspd10") || field, S.level) : null) : null;
  const c2 = draw.c2 ||= document.createElement("canvas");
  if (vec) paintVectors(c2, vec.u, vec.v, frame.nx, frame.ny, { every: 3 });
  else { c2.width = 2; c2.height = 2; c2.getContext("2d").clearRect(0, 0, 2, 2); }
  S.map.setImage("arrows", c2.toDataURL("image/png"));

  S.current = { data, field };
  drawLegend(field, range);
  drawTime(frame);
}

function drawLegend(field, [lo, hi]) {
  const u = field.units[S.units];
  $("legendBar").style.background = cmapCss(field.cmap);
  $("legendBar").style.opacity = field.cmap === "cloud" ? 0.8 : 1;
  const ticks = []; for (let i = 0; i <= 4; i++) ticks.push(u.f(lo + ((hi - lo) * i) / 4));
  $("legendTicks").innerHTML = ticks.map((t) => `<span>${fmtNum(t)}</span>`).join("");
  $("legendUnit").textContent = u.label + (field.level ? ` · ${S.level} hPa` : "");
}

function drawTime(frame) {
  const h = Math.round((frame.time - S.frames[0].time) / 3600e3);
  const t = frame.time;
  $("timeLabel").innerHTML = `${fmtLocal.format(t)} <span class="muted">· ${pad(t.getUTCHours())}:00 UTC · +${h} h</span>`;
  $("frame").value = String(S.idx);
}

function onHover(lat, lon) {
  const el = $("hover");
  if (lat === null || !S.current || !S.grid) { el.hidden = true; return; }
  const { i, j } = S.grid.locate(lon, lat), f = S.frames[S.idx];
  if (i < -0.5 || j < -0.5 || i > f.nx - 0.5 || j > f.ny - 0.5) { el.hidden = true; return; }
  const v = sample(S.current.data, f.nx, f.ny, i, j), u = S.current.field.units[S.units];
  const terr = f.has("HGT") ? sample(f.get("HGT"), f.nx, f.ny, i, j) : NaN;
  el.hidden = false;
  el.textContent = `${lat.toFixed(2)}°N ${Math.abs(lon).toFixed(2)}°W · ${Number.isFinite(v) ? fmtNum(u.f(v)) + " " + u.label : "no data (underground)"}` + (Number.isFinite(terr) ? ` · terrain ${Math.round(terr * 3.28084)} ft` : "");
}

// ------------------------------------------------------------------ playback
function setIdx(i) { S.idx = Math.max(0, Math.min(S.frames.length - 1, i)); draw(); }
function play(on) {
  S.playing = on; $("play").textContent = on ? "❚❚" : "▶";
  clearInterval(S.timer);
  if (on) S.timer = setInterval(() => setIdx(S.idx >= S.frames.length - 1 ? 0 : S.idx + 1), Number($("speed").value));
}

// ------------------------------------------------------------------ run + cache
const DB = "wrf-web", STORE = "runs";
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function cacheGet(key) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } }
async function cachePut(key, val) { try { const db = await idb(); db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key); } catch { /* storage unavailable: fine */ } }

async function startRun() {
  if (S.worker) { S.worker.terminate(); S.worker = null; $("run").textContent = "Run WRF"; setStatus("Cancelled"); return; }
  const hours = Number($("hours").value);
  S.frames = []; S.idx = 0; S.rangeCache.clear(); $("frame").max = "0"; $("log").textContent = "";
  $("run").textContent = "Cancel"; $("bar").style.width = "0";
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  S.worker = w;
  const collected = [];
  let first = true;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "status") setStatus(m.text);
    else if (m.type === "log") log(m.line);
    else if (m.type === "progress") { $("bar").style.width = `${Math.min(100, (100 * m.simHours) / m.hours)}%`; setStatus(`Simulated ${m.simHours.toFixed(1)} of ${m.hours} h · ${m.steps} steps`); }
    else if (m.type === "frame") {
      collected.push({ name: m.name, bytes: m.bytes.slice() });
      addFrame(m.bytes);
      if (first) { first = false; S.idx = 0; }
      $("bar").title = `${S.frames.length} frames`;
      if (S.frames.length === 1 || !S.playing) draw();
    } else if (m.type === "done") {
      $("run").textContent = "Run WRF"; S.worker = null; w.terminate();
      $("bar").style.width = m.success ? "100%" : $("bar").style.width;
      setStatus(m.success ? `Done · ${m.frames} frames` : `WRF stopped early (exit ${m.exitCode}). See the model log.`);
      if (m.success) { cachePut(S.manifest.cycle, { hours, frames: collected }); }
      else $("runBox").open = true, document.querySelector(".log").open = true;
    } else if (m.type === "error") {
      $("run").textContent = "Run WRF"; S.worker = null; w.terminate();
      setStatus("Error: " + m.message); log(m.stack || m.message); document.querySelector(".log").open = true;
    }
  };
  w.postMessage({ cmd: "run", hours, base: new URL("./", location.href).href });
}

// ------------------------------------------------------------------ boot
function wire() {
  $("field").onchange = () => { S.fieldId = $("field").value; $("levelRow").hidden = !fieldById(S.fieldId).level; draw(); };
  $("level").onchange = () => { S.level = Number($("level").value); draw(); };
  $("frame").oninput = () => setIdx(Number($("frame").value));
  $("play").onclick = () => play(!S.playing);
  $("prev").onclick = () => { play(false); setIdx(S.idx - 1); };
  $("next").onclick = () => { play(false); setIdx(S.idx + 1); };
  $("first").onclick = () => { play(false); setIdx(0); };
  $("last").onclick = () => { play(false); setIdx(S.frames.length - 1); };
  $("speed").onchange = () => { if (S.playing) play(true); };
  $("vectors").onchange = draw;
  $("units").onchange = () => { S.units = $("units").value; draw(); };
  $("opacity").oninput = () => S.map?.setOpacity(Number($("opacity").value) / 100);
  $("run").onclick = startRun;
  $("collapse").onclick = () => { const b = $("body"), open = !b.hidden; b.hidden = open; $("collapse").textContent = open ? "+" : "–"; $("collapse").setAttribute("aria-expanded", String(!open)); };
  addEventListener("keydown", (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); play(!S.playing); }
    else if (e.key === "ArrowLeft") { play(false); setIdx(S.idx - 1); }
    else if (e.key === "ArrowRight") { play(false); setIdx(S.idx + 1); }
  });
}

async function boot() {
  wire();
  // Debug / offline: ?frames=a.nc,b.nc loads existing wrfout files instead of running the model.
  if (params.get("frames")) {
    for (const u of params.get("frames").split(",")) addFrame(new Uint8Array(await (await fetch(u)).arrayBuffer()));
    $("cycleInfo").textContent = "Loaded wrfout files"; $("runBox").hidden = true;
    draw(); return;
  }
  try {
    const r = await fetch("data/manifest.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    S.manifest = await r.json();
  } catch (e) {
    $("cycleInfo").textContent = "No forecast data deployed yet";
    setStatus("data/manifest.json not found. Run the GitHub workflows (see README).");
    $("run").disabled = true; return;
  }
  const m = S.manifest, st = new Date(m.start.replace("_", "T") + "Z");
  $("cycleInfo").textContent = `GFS ${st.toISOString().slice(0, 13).replace("T", " ")}Z · ${m.domain.dx / 1000} km grid · ${m.domain.e_we - 1}×${m.domain.e_sn - 1} cells`;
  const cached = await cacheGet(m.cycle);
  if (cached && cached.frames?.length) {
    for (const f of cached.frames) addFrame(f.bytes);
    $("hours").value = String(cached.hours);
    setStatus(`Loaded saved run · ${S.frames.length} frames`);
    draw();
  } else if (params.get("autorun") !== "0") {
    startRun();
  } else setStatus("Ready. Press Run WRF.");
}
boot();
